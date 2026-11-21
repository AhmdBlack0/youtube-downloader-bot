// @ts-check

/*
 * YT-DLP CHILD PROCESS WRAPPER
 * ----------------------------
 * NON-NEGOTIABLE SECURITY RULES:
 * 1. MUST use child_process.spawn with an ARGUMENTS ARRAY (never exec, never shell strings).
 * 2. MUST place '--' immediately before the URL argument so yt-dlp treats the
 *    following argument strictly as a target URL, never as a flag or option.
 * 3. MUST set a hard process timeout so hung network requests don't leak processes.
 *
 * WHY NOT child_process.exec?
 * child_process.exec passes the entire command string to `/bin/sh` or `cmd.exe`.
 * If a URL contains `; rm -rf /` or `& calc.exe`, the shell interprets the separator
 * and executes the malicious command.
 * With child_process.spawn, Node passes the arguments directly to the OS `execve`
 * syscall as discrete strings. The shell is completely bypassed.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { logger } = require('../../config/logger');

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

// Common Windows fallback location for pip installed yt-dlp if not in system PATH
function resolveYtDlpBinary() {
  if (process.env.YTDLP_PATH) {
    return process.env.YTDLP_PATH;
  }

  // Check if standard Windows pip user location exists
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const candidate = path.join(
      process.env.LOCALAPPDATA,
      'Python',
      'pythoncore-3.14-64',
      'Scripts',
      'yt-dlp.exe',
    );
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return 'yt-dlp';
}

class YtDlpError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {string} [stderr]
   */
  constructor(message, code, stderr = '') {
    super(message);
    this.name = 'YtDlpError';
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * Classify yt-dlp stderr output into user-friendly domain error codes.
 *
 * @param {string} stderr
 * @returns {{ code: string, message: string }}
 */
function classifyYtDlpError(stderr) {
  const lower = stderr.toLowerCase();

  if (
    lower.includes("confirm you're not a bot") ||
    lower.includes('confirm you’re not a bot') ||
    lower.includes('bot verification') ||
    lower.includes('sign in to confirm')
  ) {
    return {
      code: 'BOT_VERIFICATION_REQUIRED',
      message:
        "YouTube requires bot verification ('Sign in to confirm you are not a bot'). Configure cookies or update yt-dlp.",
    };
  }

  if (
    lower.includes('requested format is not available') ||
    lower.includes('only images are available') ||
    lower.includes('sabr-only streaming') ||
    lower.includes('n challenge solving failed')
  ) {
    return {
      code: 'FORMAT_NOT_AVAILABLE',
      message: 'Requested format is not available or restricted by YouTube SABR experiment',
    };
  }

  if (lower.includes('private video') || lower.includes('this video is private')) {
    return { code: 'PRIVATE_VIDEO', message: 'This video or playlist is private' };
  }
  if (
    lower.includes('unavailable') ||
    lower.includes('has been removed') ||
    lower.includes('deleted') ||
    lower.includes('content warning')
  ) {
    return { code: 'DELETED_OR_UNAVAILABLE', message: 'Video is deleted or unavailable' };
  }
  if (
    lower.includes('sign in') ||
    lower.includes('members-only') ||
    lower.includes('join this channel')
  ) {
    return { code: 'RESTRICTED_ACCESS', message: 'Video is restricted or members-only' };
  }
  if (lower.includes('timed out') || lower.includes('network is unreachable')) {
    return { code: 'NETWORK_TIMEOUT', message: 'Network connection to YouTube timed out' };
  }

  return { code: 'UNKNOWN_ERROR', message: stderr.trim() || 'Failed to extract video metadata' };
}

/**
 * Fetch YouTube video or playlist metadata without downloading media.
 *
 * @param {string} targetUrl Validated canonical YouTube URL
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=30000] Process execution timeout
 * @param {string} [options.binaryPath]
 * @returns {Promise<{
 *   kind: 'VIDEO'|'PLAYLIST',
 *   title: string,
 *   duration: number|null,
 *   itemCount: number,
 *   entries: Array<{ id: string, title: string }>
 * }>}
 */
async function getMetadata(targetUrl, options = {}) {
  const timeoutMs = options.timeoutMs || 60000;
  const binary = options.binaryPath || resolveYtDlpBinary();
  const cookies =
    options.cookiesPath === null ? undefined : options.cookiesPath || getDefaultCookiesPath();

  const commonArgs = [
    '--dump-single-json',
    '--flat-playlist',
    '--no-warnings',
    '--no-check-certificates',
    '--no-check-formats', // Skip probing format URLs to accelerate metadata extraction
    '--skip-download',
    '--force-ipv4', // Prevent cloud datacenter IPv6 blocking by YouTube
    '--extractor-args',
    'youtube:player-client=android,ios,web,default',
    '--js-runtimes',
    'deno,node',
    '--remote-components',
    'ejs:github',
  ];

  const proxy = options.proxyUrl || process.env.PROXY_URL || process.env.HTTP_PROXY;
  if (proxy) {
    commonArgs.push('--proxy', proxy);
  }

  if (cookies && fs.existsSync(cookies)) {
    commonArgs.push('--cookies', cookies);
  }

  // Strict args array — no shell interpretation
  const args = [
    ...commonArgs,
    '--', // Explicit end of options: anything following is strictly the URL
    targetUrl,
  ];

  logger.debug({ binary, targetUrl }, 'Executing yt-dlp getMetadata');

  return new Promise((resolve, reject) => {
    let stdoutData = '';
    let stderrData = '';
    let isSettled = false;

    // Spawn directly without shell
    const child = spawn(binary, args, {
      shell: false,
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        child.kill('SIGKILL');
        reject(new YtDlpError(`yt-dlp metadata query timed out after ${timeoutMs}ms`, 'TIMEOUT'));
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdoutData += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderrData += chunk;
    });

    child.on('error', (err) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      reject(new YtDlpError(`Failed to spawn yt-dlp process: ${err.message}`, 'SPAWN_ERROR'));
    });

    child.on('close', (code) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);

      if (code !== 0) {
        const classified = classifyYtDlpError(stderrData);
        const usedCookies =
          options.cookiesPath === null ? undefined : options.cookiesPath || getDefaultCookiesPath();
        const isSABROrFormatError =
          classified.code === 'FORMAT_NOT_AVAILABLE' ||
          stderrData.toLowerCase().includes('requested format is not available') ||
          stderrData.toLowerCase().includes('only images are available') ||
          stderrData.toLowerCase().includes('sabr-only streaming');

        if (
          usedCookies &&
          !options.retriedWithoutCookies &&
          (classified.code === 'BOT_VERIFICATION_REQUIRED' || isSABROrFormatError)
        ) {
          logger.warn(
            { targetUrl, code: classified.code },
            'Metadata extraction failed with cookies (SABR restriction or session error). Retrying once without cookies...',
          );
          getMetadata(targetUrl, {
            ...options,
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
        const json = JSON.parse(stdoutData);
        const isPlaylist = json._type === 'playlist' || Array.isArray(json.entries);

        if (isPlaylist) {
          const rawEntries = Array.isArray(json.entries) ? json.entries : [];
          const entries = rawEntries.map((e, idx) => ({
            id: e.id || `item_${idx + 1}`,
            title: e.title || `Item ${idx + 1}`,
          }));

          resolve({
            kind: 'PLAYLIST',
            title: json.title || 'Untitled Playlist',
            duration: null,
            itemCount: entries.length,
            entries,
          });
        } else {
          resolve({
            kind: 'VIDEO',
            title: json.title || 'Untitled Video',
            duration: typeof json.duration === 'number' ? Math.round(json.duration) : null,
            itemCount: 1,
            entries: [
              {
                id: json.id || 'video',
                title: json.title || 'Untitled Video',
              },
            ],
          });
        }
      } catch (parseErr) {
        reject(
          new YtDlpError(
            `Failed to parse yt-dlp JSON output: ${parseErr.message}`,
            'JSON_PARSE_ERROR',
            stdoutData.slice(0, 300),
          ),
        );
      }
    });
  });
}

/**
 * Query the installed yt-dlp version.
 *
 * @param {string} [binaryPath]
 * @returns {Promise<string>}
 */
async function getYtDlpVersion(binaryPath) {
  const binary = binaryPath || resolveYtDlpBinary();
  return new Promise((resolve) => {
    try {
      const child = spawn(binary, ['--version'], {
        shell: false,
        windowsHide: true,
      });
      let stdout = '';
      child.stdout.on('data', (d) => {
        stdout += d;
      });
      child.on('close', (code) => {
        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim());
        } else {
          resolve('unknown');
        }
      });
      child.on('error', () => {
        resolve('unavailable');
      });
    } catch {
      resolve('unavailable');
    }
  });
}

module.exports = {
  getMetadata,
  getYtDlpVersion,
  YtDlpError,
  classifyYtDlpError,
  resolveYtDlpBinary,
};
