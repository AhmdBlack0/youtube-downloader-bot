// @ts-check

/*
 * PROGRESS THROTTLER
 * ------------------
 * WHY THROTTLING IS ESSENTIAL FOR TELEGRAM:
 * Telegram strictly rate-limits message edits (editMessageText). Sending 10 edits
 * per second will immediately trigger HTTP 429 (Too Many Requests / FLOOD_WAIT).
 *
 * This utility ensures that progress update callbacks are called at most once
 * per `intervalMs` (default 3000ms), while guaranteeing that the final update
 * is always delivered when `flush()` is called.
 * It also catches and ignores Telegram's "message is not modified" error.
 */

/**
 * @template T
 * @param {(data: T) => Promise<void>|void} onUpdate
 * @param {number} [intervalMs=3000]
 */
function createProgressThrottler(onUpdate, intervalMs = 3000) {
  let lastUpdateTime = 0;
  /** @type {T|null} */
  let pendingData = null;
  /** @type {NodeJS.Timeout|null} */
  let timeoutId = null;

  /**
   * Submit new progress data.
   * @param {T} data
   */
  async function update(data) {
    const now = Date.now();
    const elapsed = now - lastUpdateTime;

    if (elapsed >= intervalMs) {
      lastUpdateTime = now;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      pendingData = null;
      try {
        await onUpdate(data);
      } catch (err) {
        // Ignore "message is not modified" error from Telegram API
        if (!err.message?.includes('message is not modified')) {
          // Silent non-critical error
        }
      }
    } else {
      pendingData = data;
      if (!timeoutId) {
        timeoutId = setTimeout(async () => {
          timeoutId = null;
          if (pendingData !== null) {
            const dataToSend = pendingData;
            pendingData = null;
            lastUpdateTime = Date.now();
            try {
              await onUpdate(dataToSend);
            } catch (err) {
              if (!err.message?.includes('message is not modified')) {
                // Silent
              }
            }
          }
        }, intervalMs - elapsed);
      }
    }
  }

  /**
   * Flush any pending progress update immediately.
   */
  async function flush() {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (pendingData !== null) {
      const dataToSend = pendingData;
      pendingData = null;
      lastUpdateTime = Date.now();
      try {
        await onUpdate(dataToSend);
      } catch (err) {
        if (!err.message?.includes('message is not modified')) {
          // Silent
        }
      }
    }
  }

  return { update, flush };
}

module.exports = { createProgressThrottler };
