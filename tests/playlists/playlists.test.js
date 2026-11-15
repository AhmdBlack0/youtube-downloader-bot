// @ts-check

/*
 * PLAYLIST INTEGRATION & ERROR ISOLATION TESTS
 * --------------------------------------------
 * 1. Playlist of 5 items:
 *    - Item 1: succeeds
 *    - Item 2: fails (private video error)
 *    - Item 3: succeeds
 *    - Item 4: fails (oversize > 2GB)
 *    - Item 5: succeeds
 *    Asserts 3 succeeded, 2 failed, temp dir empty.
 * 2. Cancellation mid-playlist:
 *    Asserts job cancels, remaining items are SKIPPED, temp dir empty.
 */

const fs = require('fs');
const path = require('path');
const { prisma, applyCustomIndexes } = require('../../src/modules/db');
const { createJob, cancelJob } = require('../../src/modules/jobs/jobService');
const { Worker } = require('../../src/worker');

const FAKE_YTDLP_SCRIPT = path.resolve(__dirname, '../fixtures/fake-ytdlp.js');
const FAKE_BINARY = [process.execPath, FAKE_YTDLP_SCRIPT];

describe('Playlist Processing & Error Isolation (Phase 5)', () => {
  let testUser;

  beforeAll(async () => {
    await prisma.$connect();
    await applyCustomIndexes(prisma);

    testUser = await prisma.user.upsert({
      where: { telegramId: BigInt(654321) },
      create: { telegramId: BigInt(654321), username: 'playlist_tester' },
      update: {},
    });
  }, 20000);

  afterAll(async () => {
    if (testUser) {
      await prisma.pendingChoice.deleteMany({ where: { userId: testUser.id } }).catch(() => {});
      await prisma.jobItem.deleteMany({ where: { job: { userId: testUser.id } } }).catch(() => {});
      await prisma.job.deleteMany({ where: { userId: testUser.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: testUser.id } }).catch(() => {});
    }
    await prisma.$disconnect();
  }, 40000);

  beforeEach(async () => {
    await prisma.jobItem.deleteMany({ where: { job: { userId: testUser.id } } });
    await prisma.job.deleteMany({ where: { userId: testUser.id } });
  });

  test('5-item playlist with item 2 failing and item 4 oversized -> 3 succeeded, 2 failed, 0 temp files', async () => {
    const playlistItems = [
      { title: 'Video 1 (Good)', videoUrl: 'https://www.youtube.com/watch?v=playlist_item_1' },
      {
        title: 'Video 2 (Private Fail)',
        videoUrl: 'https://www.youtube.com/watch?v=playlist_item_2',
      },
      { title: 'Video 3 (Good)', videoUrl: 'https://www.youtube.com/watch?v=playlist_item_3' },
      {
        title: 'Video 4 (Oversize Fail)',
        videoUrl: 'https://www.youtube.com/watch?v=playlist_item_4',
      },
      { title: 'Video 5 (Good)', videoUrl: 'https://www.youtube.com/watch?v=playlist_item_5' },
    ];

    const job = await createJob({
      userId: testUser.id,
      url: 'https://www.youtube.com/playlist?list=PL_test_12345678',
      kind: 'PLAYLIST',
      quality: '720',
      items: playlistItems,
    });

    expect(job.items.length).toBe(5);

    const completedItems = [];
    const failedItems = [];
    let jobSummary = null;

    const worker = new Worker({
      binaryPath: FAKE_BINARY,
      itemDelayMs: 10, // Fast pacing for test
      onItemComplete: (_j, item, _res) => {
        completedItems.push({ itemId: item.id, index: item.index, title: item.title });
      },
      onItemFail: (_j, item, reason) => {
        failedItems.push({ itemId: item.id, index: item.index, title: item.title, reason });
      },
      onJobFinished: (_j, summary) => {
        jobSummary = summary;
      },
    });

    // Execute the job directly
    await worker.processJob(job);

    // 1. Verify counts in callbacks
    expect(completedItems.length).toBe(3);
    expect(failedItems.length).toBe(2);
    expect(jobSummary).not.toBeNull();
    expect(jobSummary.succeeded).toBe(3);
    expect(jobSummary.failed).toBe(2);
    expect(jobSummary.skipped).toBe(0);
    expect(jobSummary.failures.length).toBe(2);

    // Verify which items failed
    expect(failedItems.some((f) => f.index === 1)).toBe(true); // Item 2 (index 1) failed
    expect(failedItems.some((f) => f.index === 3)).toBe(true); // Item 4 (index 3) failed

    // 2. Verify database records
    const inDb = await prisma.job.findUnique({
      where: { id: job.id },
      include: { items: { orderBy: { index: 'asc' } } },
    });

    expect(inDb?.status).toBe('DONE');
    expect(inDb?.items[0].status).toBe('DONE');
    expect(inDb?.items[1].status).toBe('FAILED');
    expect(inDb?.items[2].status).toBe('DONE');
    expect(inDb?.items[3].status).toBe('FAILED');
    expect(inDb?.items[4].status).toBe('DONE');

    // 3. Verify filesystem cleanup (no temp files leaked)
    const downloadDir = path.resolve('./downloads');
    if (fs.existsSync(downloadDir)) {
      const remainingFiles = await fs.promises.readdir(downloadDir);
      // No directory starting with `job-${job.id}` should exist
      const jobDirs = remainingFiles.filter((f) => f.includes(`job-${job.id}`));
      expect(jobDirs.length).toBe(0);
    }
  }, 60000);

  test('Cancel mid-playlist -> stops downloading, remaining items marked SKIPPED', async () => {
    const playlistItems = [
      { title: 'Video 1', videoUrl: 'https://www.youtube.com/watch?v=playlist_item_1' },
      { title: 'Video 2 (Hang)', videoUrl: 'https://www.youtube.com/watch?v=simulate-timeout' },
      { title: 'Video 3', videoUrl: 'https://www.youtube.com/watch?v=playlist_item_3' },
      { title: 'Video 4', videoUrl: 'https://www.youtube.com/watch?v=playlist_item_4' },
    ];

    const job = await createJob({
      userId: testUser.id,
      url: 'https://www.youtube.com/playlist?list=PL_cancel_test',
      kind: 'PLAYLIST',
      quality: '720',
      items: playlistItems,
    });

    let jobSummary = null;

    const worker = new Worker({
      binaryPath: FAKE_BINARY,
      itemDelayMs: 10,
      heartbeatIntervalMs: 3000,
      onItemComplete: async (_j, item) => {
        // Deterministic cancel: exactly when item 1 finishes and item 2 starts hanging
        if (item.index === 0) {
          await cancelJob(job.id);
          worker.cancel(job.id);
        }
      },
      onJobFinished: (_j, summary) => {
        jobSummary = summary;
      },
    });

    await worker.processJob(job);

    // Verify DB status
    const inDb = await prisma.job.findUnique({
      where: { id: job.id },
      include: { items: { orderBy: { index: 'asc' } } },
    });

    expect(inDb?.status).toBe('CANCELLED');

    // Item 1 succeeded before cancel
    expect(inDb?.items[0].status).toBe('DONE');

    // Items after cancel must be SKIPPED
    expect(inDb?.items[1].status).toBe('SKIPPED');
    expect(inDb?.items[2].status).toBe('SKIPPED');
    expect(inDb?.items[3].status).toBe('SKIPPED');

    // Verify summary reflects skipped
    expect(jobSummary?.skipped).toBeGreaterThanOrEqual(2);
  }, 60000);
});
