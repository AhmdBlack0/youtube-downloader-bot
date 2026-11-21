// @ts-check
const { z } = require('zod');
const path = require('path');
const { sanitizeNetscapeCookies } = require('../utils/cookies');

/*
 * WHY ZOD FOR CONFIG?
 * -------------------
 * Environment variables are strings. If MAX_CONCURRENT_JOBS is accidentally
 * set to "abc", you want the process to crash IMMEDIATELY on startup with a
 * clear error, not 30 minutes later in production with "NaN is not a number".
 * Zod validates + transforms (string → number) in one step. "Fail fast" principle.
 *
 * WHY NOT dotenv ALONE?
 * dotenv loads the file, but it doesn't validate. Zod validates.
 * Together: dotenv loads → zod validates → you get a typed, safe config object.
 */

// Load .env file BEFORE validation (except in test environment)
if (process.env.NODE_ENV !== 'test') {
  require('dotenv').config();
}

/**
 * Transform a comma-separated string of IDs into an array of BigInts.
 *
 * WHY BigInt?
 * -----------
 * Telegram user IDs can exceed 2^53 - 1 (Number.MAX_SAFE_INTEGER = 9,007,199,254,740,991).
 * JavaScript's Number type silently loses precision above that. BigInt handles
 * arbitrarily large integers. We parse them once here and compare with === later.
 *
 * TRADE-OFF: BigInt can't be JSON.stringify'd directly (throws TypeError).
 * We solve this in the logger config with a custom serializer.
 */
const commaSeparatedBigInts = z
  .string()
  .min(1, 'ALLOWED_USER_IDS is required (use * to allow all users)')
  .transform((val) => {
    const trimmed = val.trim();
    if (trimmed === '*' || trimmed.toLowerCase() === 'all' || trimmed.toLowerCase() === 'public') {
      return null;
    }
    return trimmed.split(',').map((id) => BigInt(id.trim()));
  })
  .refine((arr) => arr === null || arr.length > 0, 'At least one user ID or * is required');

const envSchema = z.object({
  // Bot
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN is required'),

  // Telegram local API server
  TELEGRAM_API_ID: z.string().optional(),
  TELEGRAM_API_HASH: z.string().optional(),
  TELEGRAM_API_BASE_URL: z.string().url().optional(),

  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Access control
  ALLOWED_USER_IDS: commaSeparatedBigInts,

  // Limits — all have sensible defaults
  MAX_CONCURRENT_JOBS: z.coerce.number().int().positive().default(2),
  MAX_JOBS_PER_USER_PER_DAY: z.coerce.number().int().min(0).default(0), // 0 = unlimited
  MAX_PLAYLIST_ITEMS: z.coerce.number().int().min(0).default(0), // 0 = unlimited
  MAX_VIDEO_DURATION_SECONDS: z.coerce.number().int().min(0).default(0), // 0 = unlimited
  MAX_FILE_SIZE_BYTES: z.coerce.number().int().positive().default(10_737_418_240), // 10 GB
  JOB_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(7200), // 2 hours
  MIN_DISK_SPACE_BYTES: z.coerce.number().int().positive().default(1_073_741_824), // 1 GB
  DOWNLOAD_DIR: z.string().default('./downloads'),

  // Optional Cookies for yt-dlp authentication
  COOKIES_PATH: z.string().optional(),
  COOKIES_CONTENT: z.string().optional(),

  // Optional Proxy for bypassing cloud/datacenter IP blocks (HTTP/SOCKS5)
  PROXY_URL: z.string().url().optional(),

  // Node env
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

/**
 * Parse and validate environment variables.
 * If validation fails, the process exits with a clear error message.
 * This is intentional — we want to crash loud, not limp along with bad config.
 */
const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Using console.error directly here because the logger hasn't been created yet
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment variables:');
  // eslint-disable-next-line no-console
  console.error(parsed.error.format());
  process.exit(1);
}

// If raw Netscape cookies content was provided via env (e.g. on Railway/Cloud),
// write it to a local cookies.txt file for yt-dlp to consume seamlessly
let resolvedCookiesPath = parsed.data.COOKIES_PATH
  ? path.resolve(parsed.data.COOKIES_PATH)
  : undefined;

if (parsed.data.COOKIES_CONTENT && parsed.data.COOKIES_CONTENT.trim()) {
  try {
    const fs = require('fs');
    const autoCookiesFile = path.resolve(parsed.data.DOWNLOAD_DIR, 'cookies.txt');
    fs.mkdirSync(path.dirname(autoCookiesFile), { recursive: true });
    let content = parsed.data.COOKIES_CONTENT.trim();

    // Support Base64 encoded cookies string
    if (!content.includes('\n') && !content.includes('\t') && content.length > 50) {
      try {
        const decoded = Buffer.from(content, 'base64').toString('utf8');
        if (
          decoded.includes('# Netscape') ||
          decoded.includes('.youtube.com') ||
          decoded.includes('\t')
        ) {
          content = decoded;
        }
      } catch (_e) {
        // Fall back to raw content
      }
    }

    // Handle literal escaped newlines if pasted as single-line string
    if (content.includes('\\n') && !content.includes('\n')) {
      content = content.replace(/\\n/g, '\n');
    }
    const cleanContent = sanitizeNetscapeCookies(content);
    fs.writeFileSync(autoCookiesFile, cleanContent, { mode: 0o600 });
    resolvedCookiesPath = autoCookiesFile;
    process.env.COOKIES_PATH = autoCookiesFile;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('⚠️ Failed to save COOKIES_CONTENT to file:', err.message);
  }
} else if (!resolvedCookiesPath) {
  // If not specified via env, check if cookies.txt exists in current directory or downloads
  const fs = require('fs');
  const rootCookies = path.resolve(process.cwd(), 'cookies.txt');
  if (fs.existsSync(rootCookies)) {
    try {
      const raw = fs.readFileSync(rootCookies, 'utf8');
      const clean = sanitizeNetscapeCookies(raw);
      fs.writeFileSync(rootCookies, clean, { mode: 0o600 });
    } catch (_e) {
      /* ignore */
    }
    resolvedCookiesPath = rootCookies;
    process.env.COOKIES_PATH = rootCookies;
  }
}

const config = Object.freeze({
  bot: {
    token: parsed.data.BOT_TOKEN,
  },
  telegram: {
    apiId: parsed.data.TELEGRAM_API_ID,
    apiHash: parsed.data.TELEGRAM_API_HASH,
    apiBaseUrl: parsed.data.TELEGRAM_API_BASE_URL
      ? parsed.data.TELEGRAM_API_BASE_URL.replace(/\/+$/, '')
      : undefined,
  },
  db: {
    url: parsed.data.DATABASE_URL,
  },
  allowedUserIds: parsed.data.ALLOWED_USER_IDS,
  isPublic: parsed.data.ALLOWED_USER_IDS === null,
  limits: {
    maxConcurrentJobs: parsed.data.MAX_CONCURRENT_JOBS,
    maxJobsPerUserPerDay:
      parsed.data.MAX_JOBS_PER_USER_PER_DAY === 10 ? 0 : parsed.data.MAX_JOBS_PER_USER_PER_DAY,
    maxPlaylistItems: parsed.data.MAX_PLAYLIST_ITEMS,
    maxVideoDurationSeconds: parsed.data.MAX_VIDEO_DURATION_SECONDS,
    maxFileSizeBytes: parsed.data.MAX_FILE_SIZE_BYTES,
    jobTimeoutSeconds: parsed.data.JOB_TIMEOUT_SECONDS,
    minDiskSpaceBytes: parsed.data.MIN_DISK_SPACE_BYTES,
  },
  downloadDir: path.resolve(parsed.data.DOWNLOAD_DIR),
  cookiesPath: resolvedCookiesPath,
  network: {
    proxyUrl: parsed.data.PROXY_URL || process.env.HTTP_PROXY || process.env.HTTPS_PROXY,
  },
  nodeEnv: parsed.data.NODE_ENV,
});

module.exports = { config };
