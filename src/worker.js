// @ts-check

/*
 * BACKGROUND WORKER ENGINE (PHASE 5: PLAYLISTS & ERROR ISOLATION)
 * ----------------------------------------------------------------
 * 1. Claims next job atomically via FOR UPDATE SKIP LOCKED.
 * 2. Processes playlist items sequentially (one by one).
 * 3. Immediately uploads each completed item and DELETES IT from disk.
 * 4. Per-item error isolation: private/deleted/oversize videos fail individually
 *    without aborting the playlist.
 * 5. Single throttled progress message across the entire job.
 * 6. Cancellation support: aborts current download, marks remaining as SKIPPED.
 * 7. Dispatches final summary message (Succeeded / Failed / Skipped).
 * 8. Respects Telegram flood limits with pacing delays and @grammyjs/auto-retry.
 */

const fs = require('fs');
const path = require('path');
const { config, logger } = require('./config');
const { prisma } = require('./modules/db');
const {
  claimNextJob,
  transitionJobStatus,
  updateHeartbeat,
  recoverStaleJobs,
} = require('./modules/jobs/jobService');
const { downloadVideo } = require('./modules/downloads/downloader');
const { createProgressThrottler } = require('./utils/progressThrottle');

class Worker {
  /**
   * @param {Object} [options]
   * @param {number} [options.pollIntervalMs=1000]
   * @param {number} [options.heartbeatIntervalMs=5000]
   * @param {number} [options.staleThresholdMs=60000]
   * @param {number} [options.itemDelayMs=1500] Pacing delay between Telegram sends
   * @param {number} [options.maxConcurrent]
   * @param {string|string[]} [options.binaryPath]
   * @param {(job: any) => Promise<void>|void} [options.onJobStart]
   * @param {(job: any, progress: { itemIndex: number, total: number, title: string, percent: number, speed?: string, eta?: string }) => Promise<void>|void} [options.onProgress]
   * @param {(job: any, item: any, result: any) => Promise<void>|void} [options.onItemComplete]
   * @param {(job: any, item: any, errorReason: string) => Promise<void>|void} [options.onItemFail]
   * @param {(job: any, summary: { succeeded: number, failed: number, skipped: number, failures: Array<{ title: string, reason: string }> }) => Promise<void>|void} [options.onJobFinished]
   */
  constructor(options = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 3000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15000;
    this.staleThresholdMs = options.staleThresholdMs ?? 60000;
    this.itemDelayMs = options.itemDelayMs ?? 1500;
    this.maxConcurrent = options.maxConcurrent ?? config.limits.maxConcurrentJobs;
    this.binaryPath = options.binaryPath;

    // Callbacks
    this.onJobStart = options.onJobStart;
    this.onProgress = options.onProgress;
    this.onItemComplete = options.onItemComplete;
    this.onItemFail = options.onItemFail;
    this.onJobFinished = options.onJobFinished;

    this.isRunning = false;
    this.isTicking = false;
    this.pollTimer = null;
    this.staleCheckTimer = null;
    /** @type {Map<number, { cancelToken: { isCancelled: boolean }, heartbeatTimer: NodeJS.Timeout }>} */
    this.activeJobs = new Map();
  }

  /**
   * Start worker loop.
   */
  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info({ maxConcurrent: this.maxConcurrent }, 'Worker loop started');

    await this.recoverStale();

    this.staleCheckTimer = setInterval(() => {
      this.recoverStale().catch((err) => {
        logger.error({ error: err.message }, 'Error in stale job check');
      });
    }, 30000);

    this.scheduleNextTick(0);
  }

  /**
   * Stop worker loop.
   */
  async stop() {
    this.isRunning = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.staleCheckTimer) clearInterval(this.staleCheckTimer);

    for (const [jobId, item] of this.activeJobs.entries()) {
      item.cancelToken.isCancelled = true;
      clearInterval(item.heartbeatTimer);
      logger.info({ jobId }, 'Cancelled in-flight job on worker shutdown');
    }
    this.activeJobs.clear();
    logger.info('Worker loop stopped');
  }

  scheduleNextTick(delay = this.pollIntervalMs) {
    if (!this.isRunning) return;
    this.pollTimer = setTimeout(async () => {
      try {
        await this.tick();
      } catch (err) {
        logger.error({ error: err.message }, 'Error in worker tick');
      } finally {
        this.scheduleNextTick(this.pollIntervalMs);
      }
    }, delay);
  }

  async tick() {
    if (!this.isRunning) return;
    if (this.isTicking) return;
    if (this.activeJobs.size >= this.maxConcurrent) return;

    this.isTicking = true;
    try {
      const job = await claimNextJob(this.maxConcurrent);
      if (!job) return;

      this.processJob(job).catch((err) => {
        logger.error({ jobId: job.id, error: err.message }, 'Unhandled error in processJob');
      });
    } catch (err) {
      logger.warn({ error: err.message }, 'Database busy or connection delay during worker tick');
    } finally {
      this.isTicking = false;
    }
  }

  /**
   * Immediately trigger worker tick without waiting for poll interval.
   */
  wakeUp() {
    if (this.isRunning && !this.isTicking && this.activeJobs.size < this.maxConcurrent) {
      if (this.pollTimer) {
        clearTimeout(this.pollTimer);
        this.pollTimer = null;
      }
      this.tick().catch((err) => {
        logger.warn({ error: err.message }, 'Error in worker wakeUp tick');
      });
    }
  }

  /**
   * Cancel an in-flight job managed by this worker.
   * @param {number} jobId
   */
  cancel(jobId) {
    const active = this.activeJobs.get(jobId);
    if (active) {
      active.cancelToken.isCancelled = true;
    }
  }

  /**
   * Process a claimed Job and all its JobItems.
   *
   * @param {import('@prisma/client').Job} job
   */
  async processJob(job) {
    const jobLogger = logger.child({ jobId: job.id });
    const cancelToken = { isCancelled: false };

    // Setup periodic heartbeat & cancellation check
    const heartbeatTimer = setInterval(async () => {
      try {
        const fresh = await prisma.job.findUnique({
          where: { id: job.id },
          select: { status: true },
        });
        if (fresh?.status === 'CANCELLED') {
          cancelToken.isCancelled = true;
        } else {
          await updateHeartbeat(job.id);
        }
      } catch (hbErr) {
        jobLogger.warn({ error: hbErr.message }, 'Failed to update heartbeat');
      }
    }, this.heartbeatIntervalMs);

    this.activeJobs.set(job.id, { cancelToken, heartbeatTimer });

    // Ensure status is marked RUNNING
    await transitionJobStatus(job.id, 'QUEUED', 'RUNNING');

    if (this.onJobStart) {
      try {
        await this.onJobStart(job);
      } catch (startErr) {
        jobLogger.warn({ error: startErr.message }, 'Error in onJobStart callback');
      }
    }

    // Progress throttler for status updates (at most once every 3s)
    const throttler = createProgressThrottler(async (prog) => {
      if (this.onProgress) {
        await this.onProgress(job, prog);
      }
    }, 3000);

    try {
      // Fetch all items for this job ordered by index
      const items = await prisma.jobItem.findMany({
        where: { jobId: job.id },
        orderBy: { index: 'asc' },
      });

      const totalItems = items.length;
      jobLogger.info({ kind: job.kind, totalItems }, 'Processing job items');

      let anySucceeded = false;
      let wasCancelled = false;

      // Process items sequentially
      for (const item of items) {
        // 1. Check if job was cancelled
        const freshJob = await prisma.job.findUnique({
          where: { id: job.id },
          select: { status: true },
        });

        if (freshJob?.status === 'CANCELLED' || cancelToken.isCancelled) {
          wasCancelled = true;
          // Mark this and all remaining pending items as SKIPPED
          await prisma.jobItem.updateMany({
            where: {
              jobId: job.id,
              status: 'PENDING',
            },
            data: { status: 'SKIPPED' },
          });
          break;
        }

        // 2. Mark current item as DOWNLOADING
        await prisma.jobItem.update({
          where: { id: item.id },
          data: { status: 'DOWNLOADING' },
        });

        // 3. Isolated temp directory for this item
        const itemDir = path.join(config.downloadDir, `job-${job.id}-item-${item.id}`);
        await fs.promises.mkdir(itemDir, { recursive: true });

        try {
          // Download the single item
          const result = await downloadVideo({
            url: item.videoUrl || job.url,
            // @ts-ignore
            quality: job.quality,
            jobDir: itemDir,
            onProgress: (p) =>
              throttler.update({
                itemIndex: item.index + 1,
                total: totalItems,
                title: item.title || 'Video',
                percent: p.percent,
                speed: p.speed,
                eta: p.eta,
              }),
            cancelToken,
            timeoutMs: config.limits.jobTimeoutSeconds * 1000,
            binaryPath: this.binaryPath,
          });

          await throttler.flush();

          // Check file size against Telegram upload limit
          if (result.fileSizeBytes > config.limits.maxFileSizeBytes) {
            const sizeErrMsg = `حجم الملف (${(result.fileSizeBytes / (1024 * 1024)).toFixed(1)} MB) يتجاوز الحد الأقصى`;
            await prisma.jobItem.update({
              where: { id: item.id },
              data: {
                status: 'FAILED',
                error: sizeErrMsg,
              },
            });

            if (this.onItemFail) {
              await this.onItemFail(job, item, sizeErrMsg);
            }
          } else {
            // Mark item as DONE
            await prisma.jobItem.update({
              where: { id: item.id },
              data: {
                status: 'DONE',
                fileSizeBytes: BigInt(result.fileSizeBytes),
              },
            });
            anySucceeded = true;

            // Deliver file immediately to user
            if (this.onItemComplete) {
              await this.onItemComplete(job, item, result);
            }
          }
        } catch (itemErr) {
          if (itemErr.code === 'CANCELLED' || cancelToken.isCancelled) {
            wasCancelled = true;
            await prisma.jobItem.updateMany({
              where: {
                jobId: job.id,
                status: { in: ['PENDING', 'DOWNLOADING'] },
              },
              data: { status: 'SKIPPED' },
            });
            break;
          }

          // ERROR ISOLATION: Mark item FAILED and proceed to the next item
          jobLogger.warn({ itemId: item.id, error: itemErr.message }, 'Item failed, continuing');
          await prisma.jobItem.update({
            where: { id: item.id },
            data: {
              status: 'FAILED',
              error: itemErr.message,
            },
          });

          if (this.onItemFail) {
            await this.onItemFail(job, item, itemErr.message);
          }
        } finally {
          // NON-NEGOTIABLE SAFETY: Immediately delete this item's files from disk!
          try {
            await fs.promises.rm(itemDir, { recursive: true, force: true });
            jobLogger.debug({ itemDir }, 'Deleted item temp directory');
          } catch (rmErr) {
            jobLogger.warn({ itemDir, error: rmErr.message }, 'Failed to delete item directory');
          }

          // Pacing delay to avoid Telegram flood limits
          if (this.itemDelayMs > 0) {
            await new Promise((r) => setTimeout(r, this.itemDelayMs));
          }
        }
      }

      // 4. Compute final status & summary
      const finalItems = await prisma.jobItem.findMany({
        where: { jobId: job.id },
        orderBy: { index: 'asc' },
      });

      const succeeded = finalItems.filter((it) => it.status === 'DONE').length;
      const failed = finalItems.filter((it) => it.status === 'FAILED');
      const skipped = finalItems.filter((it) => it.status === 'SKIPPED').length;

      let finalStatus = 'DONE';
      if (wasCancelled) {
        finalStatus = 'CANCELLED';
      } else if (!anySucceeded && failed.length > 0) {
        finalStatus = 'FAILED';
      }

      await transitionJobStatus(job.id, ['QUEUED', 'RUNNING'], finalStatus);
      jobLogger.info({ finalStatus, succeeded, failed: failed.length, skipped }, 'Job finished');

      // 5. Emit summary callback
      if (this.onJobFinished) {
        await this.onJobFinished(job, {
          succeeded,
          failed: failed.length,
          skipped,
          failures: failed.map((f) => ({
            title: f.title || `Item ${f.index + 1}`,
            reason: f.error || 'خطأ غير محدد',
          })),
        });
      }
    } catch (err) {
      jobLogger.error({ error: err.message }, 'Fatal error processing job');
      await transitionJobStatus(job.id, 'RUNNING', 'FAILED', { error: err.message });
    } finally {
      clearInterval(heartbeatTimer);
      this.activeJobs.delete(job.id);
    }
  }

  async recoverStale() {
    const recovered = await recoverStaleJobs(this.staleThresholdMs);
    if (recovered.length > 0) {
      logger.warn({ count: recovered.length }, 'Recovered stale jobs');
    }
  }
}

module.exports = { Worker };
