// @ts-check

/*
 * JOB QUEUE & CONCURRENCY SERVICE
 * -------------------------------
 * NON-NEGOTIABLE CONCURRENCY RULES:
 * 1. Single active job per user enforced by PostgreSQL PARTIAL UNIQUE INDEX.
 * 2. Atomic worker claiming via `FOR UPDATE SKIP LOCKED`.
 * 3. Guarded status transitions via `updateMany({ where: { id, status: expected } })`.
 * 4. Periodic heartbeat + stale job recovery on startup and interval.
 * 5. Daily job quota checked inside the same transaction.
 */

const { prisma } = require('../db');
const { config, logger } = require('../../config');

class ActiveJobExistsError extends Error {
  /**
   * @param {string} message
   * @param {number} [activeJobId]
   */
  constructor(message, activeJobId) {
    super(message);
    this.name = 'ActiveJobExistsError';
    this.code = 'ACTIVE_JOB_EXISTS';
    this.activeJobId = activeJobId;
  }
}

class DailyLimitExceededError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'DailyLimitExceededError';
    this.code = 'DAILY_LIMIT_EXCEEDED';
  }
}

/**
 * Create a new download job.
 * Enforces per-user daily quota and single active job limit.
 *
 * @param {Object} params
 * @param {number} params.userId Internal user ID
 * @param {string} params.url Canonical YouTube URL
 * @param {'VIDEO'|'PLAYLIST'} params.kind
 * @param {string} params.quality '360'|'480'|'720'|'1080'|'mp3'
 * @param {Array<{ title: string, videoUrl: string }>} [params.items]
 * @returns {Promise<import('@prisma/client').Job & { items: import('@prisma/client').JobItem[] }>}
 */
async function createJob({ userId, url, kind, quality, items }) {
  try {
    return await prisma.$transaction(
      async (tx) => {
        // 1. Enforce per-user daily quota within the transaction
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);

        const jobsToday = await tx.job.count({
          where: {
            userId,
            createdAt: { gte: startOfDay },
          },
        });

        if (jobsToday >= config.limits.maxJobsPerUserPerDay) {
          throw new DailyLimitExceededError(
            `Daily limit of ${config.limits.maxJobsPerUserPerDay} jobs reached`,
          );
        }

        // Prepare items records
        const maxItems =
          config.limits.maxPlaylistItems > 0 ? config.limits.maxPlaylistItems : Infinity;
        const rawItems =
          Array.isArray(items) && items.length > 0
            ? items.slice(0, maxItems).map((it, idx) => ({
                index: idx,
                title: it.title || `Item ${idx + 1}`,
                videoUrl: it.videoUrl || url,
                status: 'PENDING',
              }))
            : [
                {
                  index: 0,
                  title: 'Video',
                  videoUrl: url,
                  status: 'PENDING',
                },
              ];

        // 2. Insert the Job record with items.
        const job = await tx.job.create({
          data: {
            userId,
            url,
            kind,
            quality,
            status: 'QUEUED',
            items: {
              create: rawItems,
            },
          },
          include: {
            items: true,
          },
        });

        return job;
      },
      { maxWait: 15000, timeout: 30000 },
    );
  } catch (err) {
    // If unique constraint or transaction conflict occurred, or an active job exists:
    const active = await prisma.job.findFirst({
      where: {
        userId,
        status: { in: ['QUEUED', 'RUNNING'] },
      },
      select: { id: true },
    });

    if (
      active ||
      err.code === 'P2002' ||
      err.code === 'P2034' ||
      err.message?.includes('unique_active_job_per_user')
    ) {
      throw new ActiveJobExistsError('User already has an active job in progress', active?.id);
    }
    throw err;
  }
}

/**
 * Atomically claim the next QUEUED job using FOR UPDATE SKIP LOCKED.
 * Guarantees that multiple concurrent workers never claim or block on the same job.
 *
 * @param {number} [maxConcurrent=2] Global concurrency limit
 * @returns {Promise<import('@prisma/client').Job|null>}
 */
async function claimNextJob(maxConcurrent = config.limits.maxConcurrentJobs) {
  // Single atomic statement:
  // 1. Lock the earliest QUEUED job skipping any already locked by other transactions.
  // 2. Only proceed if total currently RUNNING jobs < maxConcurrent.
  // 3. Atomically update status to RUNNING and touch updatedAt.
  // 4. Return the updated row.
  const claimed = await prisma.$queryRawUnsafe(`
    WITH next_job AS (
      SELECT id
      FROM "Job"
      WHERE status = 'QUEUED'
        AND (SELECT COUNT(*) FROM "Job" WHERE status = 'RUNNING') < ${maxConcurrent}
      ORDER BY "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "Job" j
    SET status = 'RUNNING', "updatedAt" = NOW()
    FROM next_job
    WHERE j.id = next_job.id
    RETURNING j.*;
  `);

  if (!claimed || claimed.length === 0) {
    return null;
  }

  return claimed[0];
}

/**
 * Guarded status transition: updates status ONLY IF current status matches expected.
 * Returns true if transition succeeded, false if lost a race.
 *
 * @param {number} jobId
 * @param {import('@prisma/client').JobStatus|import('@prisma/client').JobStatus[]} fromStatus
 * @param {import('@prisma/client').JobStatus} toStatus
 * @param {Object} [extraData]
 * @returns {Promise<boolean>}
 */
async function transitionJobStatus(jobId, fromStatus, toStatus, extraData = {}) {
  const statusFilter = Array.isArray(fromStatus) ? { in: fromStatus } : fromStatus;

  const res = await prisma.job.updateMany({
    where: {
      id: jobId,
      status: statusFilter,
    },
    data: {
      status: toStatus,
      updatedAt: new Date(),
      ...extraData,
    },
  });

  return res.count === 1;
}

/**
 * Guarded job cancellation: cancels a job only if it is currently QUEUED or RUNNING.
 *
 * @param {number} jobId
 * @returns {Promise<boolean>}
 */
async function cancelJob(jobId) {
  return transitionJobStatus(jobId, ['QUEUED', 'RUNNING'], 'CANCELLED');
}

/**
 * Heartbeat updater: updates updatedAt for a currently RUNNING job.
 *
 * @param {number} jobId
 * @returns {Promise<boolean>}
 */
async function updateHeartbeat(jobId) {
  const res = await prisma.job.updateMany({
    where: {
      id: jobId,
      status: 'RUNNING',
    },
    data: {
      updatedAt: new Date(),
    },
  });
  return res.count === 1;
}

/**
 * Recover stale jobs: finds jobs stuck in RUNNING with a stale heartbeat,
 * marks them FAILED, and returns their records so temp files can be cleaned.
 *
 * @param {number} [staleThresholdMs=60000]
 * @returns {Promise<import('@prisma/client').Job[]>}
 */
async function recoverStaleJobs(staleThresholdMs = 60000) {
  const thresholdDate = new Date(Date.now() - staleThresholdMs);

  const staleJobs = await prisma.job.findMany({
    where: {
      status: 'RUNNING',
      updatedAt: { lt: thresholdDate },
    },
  });

  const recovered = [];
  for (const job of staleJobs) {
    const success = await transitionJobStatus(job.id, 'RUNNING', 'FAILED', {
      error: 'Process crashed or heartbeat timed out',
    });

    if (success) {
      logger.warn({ jobId: job.id }, 'Recovered stale RUNNING job');
      recovered.push(job);
    }
  }

  return recovered;
}

/**
 * Calculate queue position for a job and overall queue workload.
 *
 * @param {number} jobId
 * @returns {Promise<{ position: number, totalQueued: number, activeWorkers: number }>}
 */
async function getQueueStats(jobId) {
  const targetJob = await prisma.job.findUnique({
    where: { id: jobId },
    select: { createdAt: true, status: true },
  });

  if (!targetJob) {
    return { position: 0, totalQueued: 0, activeWorkers: 0 };
  }

  // Execute all 3 count metrics in parallel to reduce remote DB latency
  const [aheadCount, totalQueued, activeWorkers] = await Promise.all([
    prisma.job.count({
      where: {
        status: 'QUEUED',
        createdAt: { lt: targetJob.createdAt },
      },
    }),
    prisma.job.count({
      where: { status: 'QUEUED' },
    }),
    prisma.job.count({
      where: { status: 'RUNNING' },
    }),
  ]);

  return {
    position: aheadCount + 1,
    totalQueued,
    activeWorkers,
  };
}

module.exports = {
  createJob,
  claimNextJob,
  transitionJobStatus,
  cancelJob,
  updateHeartbeat,
  recoverStaleJobs,
  getQueueStats,
  ActiveJobExistsError,
  DailyLimitExceededError,
};
