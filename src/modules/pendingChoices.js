// @ts-check

/*
 * PENDING QUALITY CHOICES MODULE
 * ------------------------------
 * WHY THIS IS CRUCIAL:
 * Telegram's `callback_data` for inline keyboard buttons has a HARD LIMIT of 64 bytes.
 * If you put a long YouTube playlist URL inside the button's callback_data:
 *   `choice:https://www.youtube.com/playlist?list=PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4:1080p`
 * That string is 85 bytes -> Telegram rejects it with `BUTTON_DATA_INVALID`!
 *
 * THE SOLUTION:
 * We generate an 8-byte cryptographic random hex token (16 characters).
 * We store { token, url, kind, title, duration, itemCount, expiresAt } in the database.
 * The button callback_data is only: `q:<token>:<quality>` (~22 bytes total).
 * When clicked, the worker looks up the record by token.
 */

const crypto = require('crypto');
const { prisma } = require('./db');
const { logger } = require('../config/logger');

// In-memory fallback cache for when DB connection is not initialized
/** @type {Map<string, { userId: number, url: string, kind: 'VIDEO'|'PLAYLIST', title: string, duration: number|null, itemCount: number|null, expiresAt: Date }>} */
const inMemoryCache = new Map();

/**
 * Generate a short 16-character hex token (8 bytes of entropy).
 * @returns {string}
 */
function generateShortToken() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Store a pending choice for a user.
 *
 * @param {Object} data
 * @param {number} data.userId Internal database user ID
 * @param {string} data.url Canonical YouTube URL
 * @param {'VIDEO'|'PLAYLIST'} data.kind
 * @param {string} data.title
 * @param {number|null} [data.duration]
 * @param {number|null} [data.itemCount]
 * @param {Array<{ id: string, title: string }>} [data.entries]
 * @param {number} [ttlSeconds=900] Time-to-live (default 15 minutes)
 * @returns {Promise<string>} The generated short token
 */
async function createPendingChoice(data, ttlSeconds = 900) {
  const token = generateShortToken();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const entriesJson = data.entries ? JSON.stringify(data.entries) : null;

  // 1. Instant in-memory cache storage (0ms access for subsequent button clicks)
  inMemoryCache.set(token, {
    userId: data.userId,
    url: data.url,
    kind: data.kind,
    title: data.title,
    duration: data.duration ?? null,
    itemCount: data.itemCount ?? null,
    entries: data.entries ?? [],
    expiresAt,
  });

  // 2. Persist to DB asynchronously for durability across restarts
  prisma.pendingChoice
    .create({
      data: {
        id: token,
        userId: data.userId,
        url: data.url,
        kind: data.kind,
        title: data.title,
        duration: data.duration ?? null,
        itemCount: data.itemCount ?? null,
        entriesJson,
        expiresAt,
      },
    })
    .catch((err) => {
      logger.debug({ err: err.message }, 'PendingChoice saved in-memory only');
    });

  return token;
}

/**
 * Retrieve a pending choice by token. Returns null if expired or missing.
 *
 * @param {string} token
 * @returns {Promise<{
 *   id: string,
 *   userId: number,
 *   url: string,
 *   kind: 'VIDEO'|'PLAYLIST',
 *   title: string|null,
 *   duration: number|null,
 *   itemCount: number|null,
 *   entries?: Array<{ id: string, title: string }>
 * }|null>}
 */
async function getPendingChoice(token) {
  // Fast-path: Check in-memory cache first (0ms latency)
  const cached = inMemoryCache.get(token);
  if (cached) {
    if (cached.expiresAt < new Date()) {
      inMemoryCache.delete(token);
      return null;
    }
    return { id: token, ...cached, entries: cached.entries || [] };
  }

  // Fallback: Check DB if bot restarted between link send and button click
  try {
    const record = await prisma.pendingChoice.findUnique({
      where: { id: token },
    });

    if (record) {
      if (record.expiresAt < new Date()) {
        await prisma.pendingChoice.delete({ where: { id: token } }).catch(() => {});
        return null;
      }
      let entries = [];
      if (record.entriesJson) {
        try {
          entries = JSON.parse(record.entriesJson);
        } catch (_err) {
          /* ignore JSON parse failure */
        }
      }
      return { ...record, entries };
    }
  } catch (err) {
    logger.debug({ err: err.message }, 'DB lookup skipped for PendingChoice');
  }

  return null;
}

module.exports = {
  createPendingChoice,
  getPendingChoice,
  generateShortToken,
  inMemoryCache,
};
