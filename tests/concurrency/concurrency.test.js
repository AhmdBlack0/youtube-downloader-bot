// @ts-check

/*
 * CONCURRENCY TESTS AGAINST REAL LOCAL POSTGRESQL
 * ------------------------------------------------
 * Tests the core distributed systems guarantees:
 * a) 20 parallel create attempts from same user -> exactly 1 succeeds, 19 rejected by DB index.
 * b) 10 queued jobs claimed by 4 parallel workers -> every job processed exactly once, never twice.
 * c) Cancel vs Finish race 100 times -> always exactly one terminal status (DONE or CANCELLED).
 * d) Crash simulation: worker dies mid-job -> stale heartbeat recovered to FAILED.
 */

const { prisma, applyCustomIndexes } = require('../../src/modules/db');
const {
  createJob,
  claimNextJob,
  transitionJobStatus,
  cancelJob,
  recoverStaleJobs,
  ActiveJobExistsError,
} = require('../../src/modules/jobs/jobService');

describe('PostgreSQL Concurrency & Job Queue', () => {
  let testUser;

  beforeAll(async () => {
    // Ensure database connection and custom indexes
    await prisma.$connect();
    await applyCustomIndexes(prisma);

    // Create a dedicated test user
    testUser = await prisma.user.upsert({
      where: { telegramId: BigInt(888888) },
      create: { telegramId: BigInt(888888), username: 'concurrency_tester' },
      update: {},
    });
  }, 20000);

  afterAll(async () => {
    // Clean up test data
    if (testUser) {
      await prisma.pendingChoice.deleteMany({ where: { userId: testUser.id } }).catch(() => {});
      await prisma.jobItem.deleteMany({ where: { job: { userId: testUser.id } } }).catch(() => {});
      await prisma.job.deleteMany({ where: { userId: testUser.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: testUser.id } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Only delete jobs belonging to concurrency test users, never wipe global jobs!
    await prisma.jobItem.deleteMany({
      where: {
        job: {
          user: {
            telegramId: {
              gte: BigInt(700000),
              lte: BigInt(999999),
            },
          },
        },
      },
    });
    await prisma.job.deleteMany({
      where: {
        user: {
          telegramId: {
            gte: BigInt(700000),
            lte: BigInt(999999),
          },
        },
      },
    });
  });

  // ── TEST A: 20 Parallel create job attempts ──────────────────────────────
  test('a) 20 parallel createJob calls from same user -> exactly 1 succeeds, 19 get ActiveJobExistsError', async () => {
    const attempts = 20;

    const promises = Array.from({ length: attempts }, (_, i) =>
      createJob({
        userId: testUser.id,
        url: `https://www.youtube.com/watch?v=video_${i}`,
        kind: 'VIDEO',
        quality: '720',
      })
        .then((job) => ({ success: true, jobId: job.id }))
        .catch((err) => ({
          success: false,
          isActiveJobError: err instanceof ActiveJobExistsError,
          code: err.code,
        })),
    );

    const results = await Promise.all(promises);

    const successes = results.filter((r) => r.success);
    const activeJobErrors = results.filter((r) => !r.success && r.isActiveJobError);

    // EXACTLY 1 must succeed
    expect(successes.length).toBe(1);

    // EXACTLY 19 must fail with ActiveJobExistsError
    expect(activeJobErrors.length).toBe(19);

    // In the database: strictly 1 active job exists
    const dbActiveCount = await prisma.job.count({
      where: {
        userId: testUser.id,
        status: { in: ['QUEUED', 'RUNNING'] },
      },
    });
    expect(dbActiveCount).toBe(1);
  });

  // ── TEST B: 10 queued jobs and 4 parallel workers ────────────────────────
  test('b) 10 jobs queued and 4 parallel workers -> every job claimed exactly once, never twice', async () => {
    // Create 10 different users and 10 queued jobs
    const jobIds = [];
    for (let i = 0; i < 10; i++) {
      const u = await prisma.user.upsert({
        where: { telegramId: BigInt(700000 + i) },
        create: { telegramId: BigInt(700000 + i), username: `worker_test_${i}` },
        update: {},
      });
      const j = await prisma.job.create({
        data: {
          userId: u.id,
          url: `https://www.youtube.com/watch?v=item_${i}`,
          kind: 'VIDEO',
          quality: '720',
          status: 'QUEUED',
        },
      });
      jobIds.push(j.id);
    }

    // 4 parallel workers repeatedly claiming jobs concurrently until all 10 are claimed
    const claimedByWorker = [[], [], [], []];
    let remaining = 10;

    async function runWorker(workerIndex) {
      while (remaining > 0) {
        // Claim with global limit = 100
        const job = await claimNextJob(100);
        if (job) {
          claimedByWorker[workerIndex].push(job.id);
          remaining--;
        } else {
          // Brief backoff if no job returned
          await new Promise((r) => setTimeout(r, 10));
        }
      }
    }

    // Run 4 workers concurrently
    await Promise.all([runWorker(0), runWorker(1), runWorker(2), runWorker(3)]);

    // Total claims across all workers must equal 10
    const allClaimedIds = claimedByWorker.flat();
    expect(allClaimedIds.length).toBe(10);

    // Every job ID must be unique (no duplicate claims by multiple workers)
    const uniqueClaimedIds = new Set(allClaimedIds);
    expect(uniqueClaimedIds.size).toBe(10);

    // Verify each original job ID was claimed
    for (const id of jobIds) {
      expect(uniqueClaimedIds.has(id)).toBe(true);
    }

    // In DB, all 10 jobs must now be in RUNNING status
    const runningCount = await prisma.job.count({
      where: { id: { in: jobIds }, status: 'RUNNING' },
    });
    expect(runningCount).toBe(10);

    // Cleanup extra users
    await prisma.job.deleteMany({ where: { id: { in: jobIds } } });
    await prisma.user.deleteMany({
      where: { telegramId: { gte: BigInt(700000), lt: BigInt(700010) } },
    });
  });

  // ── TEST C: Cancel and finish racing 100 times ───────────────────────────
  test('c) Cancel and finish racing 100 times -> always exactly one final status (DONE or CANCELLED)', async () => {
    const trials = 100;

    // Fast parallel creation of 100 users and jobs
    const userCreates = Array.from({ length: trials }, (_, i) =>
      prisma.user.upsert({
        where: { telegramId: BigInt(800000 + i) },
        create: { telegramId: BigInt(800000 + i), username: `race_user_${i}` },
        update: {},
      }),
    );
    const users = await Promise.all(userCreates);

    const jobCreates = users.map((u, i) =>
      prisma.job.create({
        data: {
          userId: u.id,
          url: `https://www.youtube.com/watch?v=race_${i}`,
          kind: 'VIDEO',
          quality: '720',
          status: 'RUNNING',
        },
      }),
    );
    const testJobs = await Promise.all(jobCreates);

    // Race cancelJob vs transitionJobStatus('RUNNING' -> 'DONE') simultaneously
    const raceResults = await Promise.all(
      testJobs.map(async (job) => {
        const [cancelWon, finishWon] = await Promise.all([
          cancelJob(job.id),
          transitionJobStatus(job.id, 'RUNNING', 'DONE'),
        ]);

        return { jobId: job.id, cancelWon, finishWon };
      }),
    );

    for (const r of raceResults) {
      // EXACTLY one must win (XOR): either cancelled or finished, never both, never neither!
      const exactlyOneWon = (r.cancelWon && !r.finishWon) || (!r.cancelWon && r.finishWon);
      expect(exactlyOneWon).toBe(true);
    }

    // Inspect database states: all 100 jobs must be either DONE or CANCELLED (never RUNNING)
    const finalJobs = await prisma.job.findMany({
      where: { id: { in: testJobs.map((j) => j.id) } },
    });

    expect(finalJobs.length).toBe(trials);
    for (const job of finalJobs) {
      expect(['DONE', 'CANCELLED']).toContain(job.status);
    }

    // Cleanup race users
    await prisma.job.deleteMany({ where: { id: { in: testJobs.map((j) => j.id) } } });
    await prisma.user.deleteMany({
      where: { telegramId: { gte: BigInt(800000), lt: BigInt(800000 + trials) } },
    });
  }, 15000);

  // ── TEST D: Crash simulation & stale recovery ────────────────────────────
  test('d) Crash simulation: worker killed mid-job -> stale job is recovered to FAILED', async () => {
    // 1. Create a job stuck in RUNNING with updatedAt 2 minutes in the past
    const staleDate = new Date(Date.now() - 120000); // 2 minutes ago
    const stuckJob = await prisma.job.create({
      data: {
        userId: testUser.id,
        url: 'https://www.youtube.com/watch?v=crashed_job',
        kind: 'VIDEO',
        quality: '720',
        status: 'RUNNING',
        updatedAt: staleDate,
      },
    });

    // 2. Run recovery with threshold of 60 seconds (60000ms)
    const recovered = await recoverStaleJobs(60000);

    expect(recovered.some((j) => j.id === stuckJob.id)).toBe(true);

    // 3. Verify in DB that job transitioned to FAILED with descriptive error
    const inDb = await prisma.job.findUnique({
      where: { id: stuckJob.id },
    });

    expect(inDb?.status).toBe('FAILED');
    expect(inDb?.error).toContain('crashed');
  });
});
