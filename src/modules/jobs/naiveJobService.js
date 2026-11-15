// @ts-check

/*
 * NAIVE JOB SERVICE (ILLUSTRATIVE / COMPARISON ONLY)
 * --------------------------------------------------
 * Demonstrates the classic "check-then-act" concurrency bug.
 * Without a database-level unique constraint, application-level checks
 * suffer from a race window under concurrent load:
 *
 * 1. Thread A checks: "Does user have an active job?" -> No.
 * 2. Thread B checks: "Does user have an active job?" -> No.
 * 3. Thread A inserts: Job created.
 * 4. Thread B inserts: Job created (DUPLICATE ACTIVE JOB!).
 */

const { prisma } = require('../db');

/**
 * Naive check-then-insert job creation.
 * Fails to prevent duplicate active jobs under concurrent requests.
 *
 * @param {Object} params
 * @param {number} params.userId
 * @param {string} params.url
 * @param {'VIDEO'|'PLAYLIST'} params.kind
 * @param {string} params.quality
 */
async function naiveCreateJob({ userId, url, kind, quality }) {
  // Application-level check
  const existingActive = await prisma.job.findFirst({
    where: {
      userId,
      status: { in: ['QUEUED', 'RUNNING'] },
    },
  });

  if (existingActive) {
    throw new Error('You already have an active job');
  }

  // Artificial microscopic delay (or normal event loop latency) exposes the race window
  await new Promise((r) => setTimeout(r, 10));

  // Insert without database-level protection
  return await prisma.job.create({
    data: {
      userId,
      url,
      kind,
      quality,
      status: 'QUEUED',
    },
  });
}

module.exports = { naiveCreateJob };
