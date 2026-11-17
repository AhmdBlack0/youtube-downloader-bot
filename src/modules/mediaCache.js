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

/**
 * Retrieve cached Telegram file_id for a given YouTube video ID and quality.
 *
 * @param {string} youtubeId 11-char YouTube ID
 * @param {string} quality 'mp3'|'360'|'480'|'720'|'1080'
 * @returns {Promise<import('@prisma/client').MediaCache | null>}
 */
async function getCachedMedia(youtubeId, quality) {
  if (!youtubeId || !quality) return null;

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
};
