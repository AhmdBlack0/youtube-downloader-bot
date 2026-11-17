// @ts-check

/*
 * MEDIA CACHE MODULE — Instant Delivery via Telegram file_id
 * -----------------------------------------------------------
 * Maps YouTube video IDs and requested quality to Telegram's cloud file_id.
 * When a hit occurs:
 *   - 0 download from YouTube
 *   - 0 re-encoding with FFmpeg
 *   - 0 upload bandwidth used
 *   - Instant sub-second delivery to the user!
 */

const { prisma } = require('./db');
const { logger } = require('../config/logger');

// --- In-Memory L1 Cache (0.001 ms instant lookup) ---
/** @type {Map<string, { data: import('@prisma/client').MediaCache, expiresAt: number }>} */
const l1Cache = new Map();
const L1_CACHE_MAX = 2000;
const L1_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function getL1CacheKey(youtubeId, quality) {
  return `${youtubeId}:${quality}`;
}

function getFromL1Cache(youtubeId, quality) {
  const key = getL1CacheKey(youtubeId, quality);
  const entry = l1Cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    l1Cache.delete(key);
    return null;
  }
  return entry.data;
}

function setToL1Cache(youtubeId, quality, data) {
  if (l1Cache.size >= L1_CACHE_MAX) {
    const oldestKey = l1Cache.keys().next().value;
    if (oldestKey) l1Cache.delete(oldestKey);
  }
  l1Cache.set(getL1CacheKey(youtubeId, quality), {
    data,
    expiresAt: Date.now() + L1_TTL_MS,
  });
}

function clearL1Cache() {
  l1Cache.clear();
}

/**
 * Retrieve cached Telegram file_id for a given YouTube video ID and quality.
 *
 * @param {string} youtubeId 11-char YouTube ID
 * @param {string} quality 'mp3'|'360'|'480'|'720'|'1080'
 * @returns {Promise<import('@prisma/client').MediaCache | null>}
 */
async function getCachedMedia(youtubeId, quality) {
  if (!youtubeId || !quality) return null;

  // 1. Instant L1 in-memory lookup (0ms, zero database I/O)
  const l1Hit = getFromL1Cache(youtubeId, quality);
  if (l1Hit) {
    logger.info({ youtubeId, quality, fileId: l1Hit.fileId }, '⚡ L1 In-Memory Cache HIT! (0ms)');
    return l1Hit;
  }

  // 2. L2 Database lookup (PostgreSQL)
  try {
    const cached = await prisma.mediaCache.findUnique({
      where: {
        youtubeId_quality: {
          youtubeId,
          quality,
        },
      },
    });

    if (cached) {
      setToL1Cache(youtubeId, quality, cached);
      logger.info(
        { youtubeId, quality, fileId: cached.fileId },
        '⚡ Media cache HIT! Instant delivery available',
      );
    }

    return cached;
  } catch (err) {
    logger.warn({ youtubeId, quality, error: err.message }, 'Failed to query MediaCache');
    return null;
  }
}

/**
 * Save or update Telegram file_id for a YouTube video.
 *
 * @param {Object} entry
 * @param {string} entry.youtubeId
 * @param {string} entry.quality
 * @param {string} entry.fileId
 * @param {string} [entry.fileUniqueId]
 * @param {string} [entry.title]
 * @param {string} [entry.performer]
 * @param {number} [entry.duration]
 * @param {number|bigint} [entry.fileSizeBytes]
 * @param {string} [entry.mimeType]
 * @returns {Promise<import('@prisma/client').MediaCache | null>}
 */
async function saveCachedMedia(entry) {
  if (!entry.youtubeId || !entry.quality || !entry.fileId) {
    return null;
  }

  try {
    const fileSizeBytes =
      entry.fileSizeBytes !== null && entry.fileSizeBytes !== undefined
        ? BigInt(entry.fileSizeBytes)
        : null;

    const saved = await prisma.mediaCache.upsert({
      where: {
        youtubeId_quality: {
          youtubeId: entry.youtubeId,
          quality: entry.quality,
        },
      },
      create: {
        youtubeId: entry.youtubeId,
        quality: entry.quality,
        fileId: entry.fileId,
        fileUniqueId: entry.fileUniqueId || null,
        title: entry.title || null,
        performer: entry.performer || null,
        duration: entry.duration || null,
        fileSizeBytes,
        mimeType: entry.mimeType || null,
      },
      update: {
        fileId: entry.fileId,
        fileUniqueId: entry.fileUniqueId || null,
        title: entry.title || null,
        performer: entry.performer || null,
        duration: entry.duration || null,
        fileSizeBytes,
        mimeType: entry.mimeType || null,
      },
    });

    if (saved) {
      setToL1Cache(entry.youtubeId, entry.quality, saved);
    }

    logger.info(
      { youtubeId: entry.youtubeId, quality: entry.quality, fileId: entry.fileId },
      '💾 Saved media file_id to MediaCache',
    );

    return saved;
  } catch (err) {
    logger.warn({ entry, error: err.message }, 'Failed to save to MediaCache');
    return null;
  }
}

module.exports = {
  getCachedMedia,
  saveCachedMedia,
  clearL1Cache,
};
