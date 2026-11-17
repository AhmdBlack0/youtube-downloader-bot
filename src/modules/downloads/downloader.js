// @ts-check

/*
 * VIDEO DOWNLOAD ENGINE
 * ---------------------
 * Handles single video or audio downloads with format selectors, fallbacks,
 * real-time progress parsing, thumbnail extraction, and process tree lifecycle.
 */

const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { logger } = require('../../config/logger');
const { resolveYtDlpBinary, YtDlpError, classifyYtDlpError } = require('./ytdlp');

function getDefaultCookiesPath() {
  if (process.env.COOKIES_PATH && fs.existsSync(process.env.COOKIES_PATH)) {
    return path.resolve(process.env.COOKIES_PATH);
  }
  const rootCookies = path.resolve(process.cwd(), 'cookies.txt');
  if (fs.existsSync(rootCookies)) {
    return rootCookies;
  }
  const dlCookies = path.resolve(process.cwd(), 'downloads', 'cookies.txt');
  if (fs.existsSync(dlCookies)) {
    return dlCookies;
  }
  return undefined;
}

/**
 * Kill a process and all its child sub-processes (e.g. ffmpeg) cleanly.
 *
 * @param {import('child_process').ChildProcess} child
 */
function killProcessTree(child) {
  if (!child || !child.pid) return;

  try {
    if (process.platform === 'win32') {
      // Windows: taskkill /T kills process tree, /F forces termination
      exec(`taskkill /pid ${child.pid} /T /F`, () => {});
    } else {
      // Unix: send SIGKILL to the process group or process directly
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

/**
 * Build yt-dlp arguments for video or audio download.
 *
 * @param {string} quality '360'|'480'|'720'|'1080'|'mp3'
 * @param {string} jobDir Output directory for this specific job
 * @param {string} targetUrl Sanitized canonical URL
 * @param {Object} [options]
 * @param {string} [options.cookiesPath] Optional cookies file path
 * @returns {string[]}
 */
function buildDownloadArgs(quality, jobDir, targetUrl, options = {}) {
  const outputTemplate = path.join(jobDir, '%(id)s.%(ext)s');
  const cookies =
    options.cookiesPath === null ? undefined : options.cookiesPath || getDefaultCookiesPath();

  const commonArgs = [
    '--no-check-certificates',
    '--no-warnings',
    '--no-mtime', // Skip writing file modification times for faster I/O
    '--extractor-args',
    'youtube:player-client=android,web,default',
    '--js-runtimes',
    'node',
    '--remote-components',
    'ejs:github',
    '--http-chunk-size',
    '10M', // Sequential 10MB chunk ranges bypass YouTube TCP bandwidth throttling
    '--concurrent-fragments',
    '16', // Download up to 16 fragments in parallel for DASH/HLS
    '--throttled-rate',
    '100K', // Auto-reconnect if YouTube throttles speed below 100 KB/s
    '--buffer-size',
    '16M',
    '--embed-metadata',
    '--progress',
    '--newline',
    '--progress-template',
    'PROGRESS:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '--print',
    'after_move:FINAL:%(filepath)s|%(height)s|%(width)s|%(duration)s|%(title)s|%(uploader)s',
    '-o',
    outputTemplate,
  ];

  if (cookies && fs.existsSync(cookies)) {
    commonArgs.push('--cookies', cookies);
  }

  if (quality === 'mp3') {
    return [
      ...commonArgs,
      '-f',
      '140/ba[ext=m4a]/ba/b/best', // Direct AAC audio, falling back to best audio, pre-merged stream, or best stream
      '-x', // Extract audio track
      '--audio-format',
      'm4a', // Native Telegram audio format
      '--',
      targetUrl,
    ];
  }

  const height = parseInt(quality, 10);
  // Format selector with cascade fallback:
  // 1. Best video at or below requested height that fits under Telegram's single-file limit (1800M) + best audio in MP4/M4A
  // 2. Best video at or below requested height that fits under single-file limit + best audio
  // 3. Best video at or below requested height + best audio in MP4/M4A
  // 4. Best video at or below requested height + best audio
  // 5. Pre-merged single stream at or below requested height
  // 6. Any best available video+audio or stream fallback
  const maxVid = '1800M';
  const formatSelector = `bv*[height<=${height}][filesize<${maxVid}][ext=mp4]+ba[ext=m4a]/bv*[height<=${height}][filesize_approx<${maxVid}][ext=mp4]+ba[ext=m4a]/bv*[height<=${height}][filesize<${maxVid}]+ba/bv*[height<=${height}][filesize_approx<${maxVid}]+ba/bv*[height<=${height}][ext=mp4]+ba[ext=m4a]/bv*[height<=${height}]+ba/b[height<=${height}]/bv*+ba/b/best`;

  return [
    ...commonArgs,
    '-f',
    formatSelector,
    '--merge-output-format',
    'mp4', // Ensure final combined output is always standard MP4
    '--write-thumbnail', // Download video thumbnail
    '--convert-thumbnails',
    'jpg', // Convert thumbnail to JPG for Telegram
    '--',
    targetUrl,
  ];
}

/**
 * Download a video or audio file with progress notifications.
 *
 * @param {Object} params
 * @param {string} params.url Sanitized YouTube URL
 * @param {'360'|'480'|'720'|'1080'|'mp3'} params.quality
 * @param {string} params.jobDir Directory dedicated to this job
 * @param {(progress: { percent: number, speed: string, eta: string }) => void} [params.onProgress]
 * @param {number} [params.timeoutMs=1800000] 30 min default timeout
 * @param {string} [params.binaryPath]
 * @param {{ isCancelled: boolean }} [params.cancelToken]
 * @returns {Promise<{
 *   filePath: string,
 *   thumbnailPath: string|null,
 *   fileSizeBytes: number,
 *   actualHeight: number|null,
 *   actualWidth: number|null,
 *   actualDuration: number|null,
 *   title: string|null,
 *   uploader: string|null,
 *   isFallback: boolean,
 *   requestedQuality: string
 * }>}
 */
async function downloadVideo({
  url,
  quality,
  jobDir,
  onProgress,
  timeoutMs = 1800000,
  binaryPath,
  cancelToken,
  cookiesPath,
  retriedWithoutCookies = false,
}) {
  const binary = binaryPath || resolveYtDlpBinary();
  const rawArgs = buildDownloadArgs(quality, jobDir, url, { cookiesPath });

  let spawnCmd = binary;
  let args = rawArgs;

  if (Array.isArray(binary)) {
    spawnCmd = binary[0];
    args = [...binary.slice(1), ...rawArgs];
  }

  logger.info({ quality, jobDir, url }, 'Starting downloadVideo');

  return new Promise((resolve, reject) => {
    let finalOutputLine = '';
    let stderrData = '';
    let isSettled = false;

    const child = spawn(spawnCmd, args, {
      shell: false,
      windowsHide: true,
    });

    // Timeout guard
    const timer = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        killProcessTree(child);
        reject(new YtDlpError(`Download timed out after ${timeoutMs}ms`, 'TIMEOUT'));
      }
    }, timeoutMs);

    // Cancellation check interval
    let cancelChecker = null;
    if (cancelToken) {
      cancelChecker = setInterval(() => {
        if (cancelToken.isCancelled && !isSettled) {
          isSettled = true;
          clearInterval(cancelChecker);
          clearTimeout(timer);
          killProcessTree(child);
          reject(new YtDlpError('Download was cancelled by user', 'CANCELLED'));
        }
      }, 100);
    }

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      const lines = text.split(/\r?\n/);

      for (const line of lines) {
        if (line.startsWith('FINAL:')) {
          finalOutputLine = line.replace('FINAL:', '').trim();
          continue;
        }

        if (line.startsWith('PROGRESS:') && onProgress) {
          const parts = line.replace('PROGRESS:', '').split('|');
          const percentStr = parts[0]?.replace('%', '').trim();
          const speed = parts[1]?.trim() || '';
          const eta = parts[2]?.trim() || '';
          const percent = parseFloat(percentStr) || 0;

          onProgress({ percent, speed, eta });
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrData += chunk.toString();
    });

    child.on('error', (err) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      if (cancelChecker) clearInterval(cancelChecker);
      reject(new YtDlpError(`Failed to spawn download process: ${err.message}`, 'SPAWN_ERROR'));
    });

    child.on('close', async (code) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      if (cancelChecker) clearInterval(cancelChecker);

      if (code !== 0) {
        const classified = classifyYtDlpError(stderrData);
        const usedCookies =
          cookiesPath === null ? undefined : cookiesPath || getDefaultCookiesPath();
        if (
          classified.code === 'BOT_VERIFICATION_REQUIRED' &&
          usedCookies &&
          !retriedWithoutCookies
        ) {
          logger.warn(
            { url },
            'Bot verification required with cookies (session may be expired). Retrying once without cookies...',
          );
          downloadVideo({
            url,
            quality,
            jobDir,
            onProgress,
            timeoutMs,
            binaryPath,
            cancelToken,
            cookiesPath: null,
            retriedWithoutCookies: true,
          })
            .then(resolve)
            .catch(reject);
          return;
        }
        reject(new YtDlpError(classified.message, classified.code, stderrData));
        return;
      }

      try {
        // Parse final metadata printed by after_move:FINAL:filepath|height|width|duration|title|uploader
        let filePath = '';
        let actualHeight = null;
        let actualWidth = null;
        let actualDuration = null;
        let title = null;
        let uploader = null;

        if (finalOutputLine) {
          const parts = finalOutputLine.split('|');
          filePath = parts[0]?.trim() || '';
          actualHeight = parts[1] && parts[1] !== 'NA' ? parseInt(parts[1], 10) : null;
          actualWidth = parts[2] && parts[2] !== 'NA' ? parseInt(parts[2], 10) : null;
          actualDuration = parts[3] && parts[3] !== 'NA' ? parseInt(parts[3], 10) : null;
          if (parts.length > 5) {
            const rawUploader = parts[parts.length - 1]?.trim();
            uploader = rawUploader && rawUploader !== 'NA' ? rawUploader : null;
            const rawTitle = parts
              .slice(4, parts.length - 1)
              .join('|')
              .trim();
            title = rawTitle && rawTitle !== 'NA' ? rawTitle : null;
          } else if (parts.length === 5) {
            const rawTitle = parts[4]?.trim();
            title = rawTitle && rawTitle !== 'NA' ? rawTitle : null;
          }
        }

        // If after_move wasn't captured or file path empty, search jobDir for the media file
        if (!filePath || !fs.existsSync(filePath)) {
          const files = await fs.promises.readdir(jobDir);
          const mediaFile = files.find(
            (f) => f.endsWith('.mp4') || f.endsWith('.mp3') || f.endsWith('.m4a'),
          );
          if (!mediaFile) {
            reject(
              new YtDlpError('Downloaded media file not found in job directory', 'FILE_NOT_FOUND'),
            );
            return;
          }
          filePath = path.join(jobDir, mediaFile);
        }

        const stat = await fs.promises.stat(filePath);

        // Find thumbnail if generated
        let thumbnailPath = null;
        const potentialThumb = filePath.replace(/\.(mp4|mp3|m4a)$/, '.jpg');
        if (fs.existsSync(potentialThumb)) {
          thumbnailPath = potentialThumb;
        }

        // Detect fallback: user asked for e.g. 1080p, but actual height is <= 720p
        let isFallback = false;
        if (quality !== 'mp3' && actualHeight) {
          const requestedHeight = parseInt(quality, 10);
          if (actualHeight < requestedHeight) {
            isFallback = true;
          }
        }

        resolve({
          filePath,
          thumbnailPath,
          fileSizeBytes: stat.size,
          actualHeight,
          actualWidth,
          actualDuration,
          title,
          uploader,
          isFallback,
          requestedQuality: quality,
        });
      } catch (err) {
        reject(
          new YtDlpError(`Error inspecting downloaded file: ${err.message}`, 'INSPECTION_ERROR'),
        );
      }
    });
  });
}

module.exports = {
  downloadVideo,
  buildDownloadArgs,
  killProcessTree,
};
