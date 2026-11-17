// @ts-check

/*
 * ENTRY POINT — index.js (PHASE 5: PLAYLIST WIRING)
 * -------------------------------------------------
 * Coordinates bot, worker, per-item media delivery, throttled progress updates,
 * and final summary reports.
 */

const { InputFile } = require('grammy');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { config, logger } = require('./config');
const { createBot } = require('./bot');
const { prisma, applyCustomIndexes } = require('./modules/db');
const { Worker } = require('./worker');
const { getYtDlpVersion } = require('./modules/downloads/ytdlp');
const { escapeMarkdown } = require('./bot/handlers/url');
const { formatBytes, formatDuration } = require('./utils/format');
const { parseYouTubeUrl } = require('./utils/url');
const { saveCachedMedia } = require('./modules/mediaCache');

/**
 * Re-encode oversized audio using FFmpeg to guarantee it fits under Telegram's 50 MB cloud Bot API limit.
 * @param {string} inputPath
 * @param {number} currentSizeBytes
 * @param {number} [durationSeconds]
 * @param {string} [title]
 * @param {string} [artist]
 * @returns {Promise<string>}
 */
async function compressAudioToFitTelegram(
  inputPath,
  currentSizeBytes,
  durationSeconds,
  title,
  artist,
) {
  const targetBytes = 45 * 1024 * 1024; // 45 MB target buffer
  if (currentSizeBytes <= targetBytes) {
    return inputPath;
  }

  const duration = durationSeconds && durationSeconds > 0 ? durationSeconds : 3600;
  // Calculate bitrate to fit 45 MB
  let bitrateKbps = Math.floor((targetBytes * 8) / (duration * 1000));
  bitrateKbps = Math.max(24, Math.min(64, bitrateKbps));

  const outputPath = inputPath.replace(/\.(mp3|m4a)$/, `_${bitrateKbps}k.mp3`);

  const ffmpegArgs = ['-y', '-i', inputPath, '-b:a', `${bitrateKbps}k`, '-ac', '1'];
  if (title) {
    ffmpegArgs.push('-metadata', `title=${title}`);
  }
  if (artist) {
    ffmpegArgs.push('-metadata', `artist=${artist}`);
  }
  ffmpegArgs.push(outputPath);

  return new Promise((resolve) => {
    // -ac 1 converts to mono to preserve clarity at lower bitrates
    execFile('ffmpeg', ffmpegArgs, (err) => {
      if (err || !fs.existsSync(outputPath)) {
        resolve(inputPath);
      } else {
        resolve(outputPath);
      }
    });
  });
}

/**
 * Split oversized video into segments using FFmpeg stream copy (-c copy).
 * Zero re-encoding, preserves 100% original quality, executes in seconds.
 *
 * @param {string} inputPath
 * @param {number} currentSizeBytes
 * @param {number} [durationSeconds]
 * @param {string} outputDir
 * @param {number} [targetBytes] Target segment size in bytes
 * @returns {Promise<string[]>}
 */
async function splitVideoToFitTelegram(
  inputPath,
  currentSizeBytes,
  durationSeconds,
  outputDir,
  targetBytes = 46 * 1024 * 1024,
) {
  if (currentSizeBytes <= targetBytes) {
    return [inputPath];
  }

  const duration = durationSeconds && durationSeconds > 0 ? durationSeconds : 3600;
  // Calculate duration per segment proportional to size
  const segmentDuration = Math.max(
    10,
    Math.floor((targetBytes / currentSizeBytes) * duration * 0.95),
  );

  const ext = path.extname(inputPath) || '.mp4';
  const segmentTemplate = path.join(outputDir, `part_%03d${ext}`);
  const ffmpegArgs = [
    '-y',
    '-i',
    inputPath,
    '-c',
    'copy',
    '-map',
    '0',
    '-segment_time',
    String(segmentDuration),
    '-f',
    'segment',
    '-reset_timestamps',
    '1',
    segmentTemplate,
  ];

  return new Promise((resolve) => {
    execFile('ffmpeg', ffmpegArgs, (err) => {
      if (err) {
        resolve([inputPath]);
        return;
      }
      try {
        const parts = fs
          .readdirSync(outputDir)
          .filter((f) => f.startsWith('part_') && f.endsWith(ext))
          .sort()
          .map((f) => path.join(outputDir, f));

        if (parts.length > 0) {
          resolve(parts);
        } else {
          resolve([inputPath]);
        }
      } catch {
        resolve([inputPath]);
      }
    });
  });
}

// Track progress message IDs per job so the worker can update them
/** @type {Map<number, { chatId: number, messageId: number }>} */
const jobMessageMap = new Map();

async function main() {
  // 1. Connect to PostgreSQL and apply custom indexes
  try {
    await prisma.$connect();
    await applyCustomIndexes(prisma);
    logger.info('✅ Connected to PostgreSQL & custom indexes applied');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('❌ Failed to connect to PostgreSQL:', err.message || err);
    logger.error({ error: err.message, stack: err.stack }, '❌ Failed to connect to PostgreSQL');
    process.exit(1);
  }

  // 1b. Check & log yt-dlp version on startup
  const fs = require('fs');
  const ytDlpVersion = await getYtDlpVersion();
  const cookiesConfigured = !!(config.cookiesPath && fs.existsSync(config.cookiesPath));
  logger.info({ ytDlpVersion, cookiesConfigured }, '🎬 yt-dlp initialized');

  // 2. Create the Telegram bot instance
  const bot = createBot();

  // 3. Create the background worker with playlist event hooks
  const worker = new Worker({
    maxConcurrent: config.limits.maxConcurrentJobs,

    // When a job starts RUNNING, notify user if they were in a queue
    onJobStart: async (job) => {
      const msgInfo = jobMessageMap.get(job.id);
      if (!msgInfo) return;

      try {
        await bot.api.editMessageText(
          msgInfo.chatId,
          msgInfo.messageId,
          `⏳ *جاري التحميل والمعالجة...*\n\nيرجى الانتظار، سيتم إرسال الملف فور اكتماله\\.`,
          { parse_mode: 'Markdown' },
        );
      } catch (_err) {
        /* ignore */
      }
    },

    // Progress updates: throttled live progress for both single videos and playlists
    onProgress: async (job, prog) => {
      const msgInfo = jobMessageMap.get(job.id);
      if (!msgInfo) return;

      const now = Date.now();
      const lastUpdateKey = `${job.id}_last_progress`;
      // @ts-ignore
      const lastUpdateTime = jobMessageMap.get(lastUpdateKey) || 0;

      // Throttle edits to at least 3.5 seconds to comply with Telegram rate limits
      if (now - lastUpdateTime < 3500 && prog.percent < 99) {
        return;
      }
      // @ts-ignore
      jobMessageMap.set(lastUpdateKey, now);

      let text = `⏳ *جاري التحميل والمعالجة...*\n\n`;
      if (prog.total > 1) {
        text += `📋 *العنصر ${prog.itemIndex} من ${prog.total}:* ${escapeMarkdown(prog.title)}\n`;
      }
      if (prog.percent > 0) {
        text += `📊 *التقدم:* ${prog.percent.toFixed(1)}%\n`;
      }
      if (prog.speed) {
        text += `🚀 *السرعة:* ${escapeMarkdown(prog.speed)}`;
        if (prog.eta) {
          text += ` \\| ⏱️ *المتبقي:* ${escapeMarkdown(prog.eta)}`;
        }
      }

      try {
        await bot.api.editMessageText(msgInfo.chatId, msgInfo.messageId, text, {
          parse_mode: 'Markdown',
        });
      } catch (_err) {
        // Ignore Telegram message not modified errors
      }
    },

    // Deliver each completed item immediately
    onItemComplete: async (job, item, result) => {
      const user = await prisma.user.findUnique({ where: { id: job.userId } });
      if (!user) return;
      const chatId = Number(user.telegramId);

      const msgInfo = jobMessageMap.get(job.id);
      const formattedSize = formatBytes(result.fileSizeBytes);

      // Immediately let user know download finished and upload is starting!
      if (msgInfo) {
        try {
          await bot.api.editMessageText(
            msgInfo.chatId,
            msgInfo.messageId,
            `📤 *تم اكتمال التحميل بنجاح (${formattedSize})!*\n\nجاري الرفع والإرسال إلى تيليجرام الآن...`,
            { parse_mode: 'Markdown' },
          );
        } catch (_err) {
          /* ignore */
        }
      }

      const rawTitle =
        item.title && item.title !== 'Video' && item.title !== 'فيديو'
          ? item.title
          : result.title || item.title || 'مقطع صوتي';
      const mediaTitle = rawTitle;
      const durationSeconds = result.actualDuration || undefined;
      const performer = result.uploader || 'YouTube';

      let caption = `🎬 *${escapeMarkdown(mediaTitle)}*`;
      if (durationSeconds) {
        caption += `\n⏱️ _المدة: ${formatDuration(durationSeconds)}_`;
      }
      if (result.isFallback && result.actualHeight) {
        caption += `\n⚠️ _(دقة ${result.actualHeight}p بدلاً من ${job.quality}p)_`;
      }

      // Send chat action and keep it active during file upload
      const chatAction = job.quality === 'mp3' ? 'upload_voice' : 'upload_video';
      bot.api.sendChatAction(chatId, chatAction).catch(() => {});
      const actionInterval = setInterval(() => {
        bot.api.sendChatAction(chatId, chatAction).catch(() => {});
      }, 4000);

      try {
        let sentMsg;
        if (job.quality === 'mp3') {
          if (result.cachedFileId) {
            sentMsg = await bot.api.sendAudio(chatId, result.cachedFileId, {
              caption,
              title: mediaTitle,
              performer,
              duration: durationSeconds,
              parse_mode: 'Markdown',
            });
          } else {
            let uploadPath = result.filePath;
            // If file is > 48 MB and standard Telegram cloud API is used, compress with ffmpeg
            if (result.fileSizeBytes > 48 * 1024 * 1024 && !config.telegram.apiBaseUrl) {
              uploadPath = await compressAudioToFitTelegram(
                result.filePath,
                result.fileSizeBytes,
                result.actualDuration,
                mediaTitle,
                performer,
              );
            }

            sentMsg = await bot.api.sendAudio(chatId, new InputFile(uploadPath), {
              caption,
              title: mediaTitle,
              performer,
              duration: durationSeconds,
              parse_mode: 'Markdown',
            });
          }
        } else {
          if (result.cachedFileId) {
            sentMsg = await bot.api.sendVideo(chatId, result.cachedFileId, {
              caption,
              duration: durationSeconds,
              supports_streaming: true,
              parse_mode: 'Markdown',
            });
          } else {
            // Determine maximum single-file upload size allowed by Telegram:
            // Local Bot API allows up to 2000 MB (safe target: 1950 MB).
            // Cloud Bot API allows up to 50 MB (safe target: 46 MB).
            const maxVideoPartBytes = config.telegram.apiBaseUrl
              ? 1950 * 1024 * 1024
              : 46 * 1024 * 1024;

            if (result.fileSizeBytes > maxVideoPartBytes) {
              const parts = await splitVideoToFitTelegram(
                result.filePath,
                result.fileSizeBytes,
                result.actualDuration,
                path.dirname(result.filePath),
                maxVideoPartBytes,
              );

              if (parts.length > 1) {
                for (let i = 0; i < parts.length; i++) {
                  const partPath = parts[i];
                  const partStats = fs.statSync(partPath);
                  const partSize = formatBytes(partStats.size);
                  const partCaption =
                    `🎬 *${escapeMarkdown(mediaTitle)}*\n` +
                    `📦 *الجزء (${i + 1} من ${parts.length})* • ${partSize}\n` +
                    `⏱️ *المدة:* ${formatDuration(durationSeconds)}`;

                  sentMsg = await bot.api.sendVideo(chatId, new InputFile(partPath), {
                    caption: partCaption,
                    supports_streaming: true,
                    parse_mode: 'Markdown',
                    thumbnail:
                      result.thumbnailPath && i === 0
                        ? new InputFile(result.thumbnailPath)
                        : undefined,
                  });
                }
              } else {
                throw new Error(
                  `حجم الفيديو (${formattedSize}) يتجاوز الحد الأقصى المسموح به للبوتات في تيليجرام (${formatBytes(maxVideoPartBytes)}). يمكنك اختيار دقة أقل (مثل 720p أو 480p أو صوت فقط MP3).`,
                );
              }
            } else {
              sentMsg = await bot.api.sendVideo(chatId, new InputFile(result.filePath), {
                caption,
                duration: result.actualDuration || undefined,
                width: result.actualWidth || undefined,
                height: result.actualHeight || undefined,
                thumbnail: result.thumbnailPath ? new InputFile(result.thumbnailPath) : undefined,
                supports_streaming: true,
                parse_mode: 'Markdown',
              });
            }
          }
        }

        // Cache the newly delivered media file for future 1-second instant downloads
        if (sentMsg && !result.cachedFileId) {
          const parsedUrl = parseYouTubeUrl(item.videoUrl || job.url);
          const youtubeId = parsedUrl.id;
          if (youtubeId) {
            const fileObj = sentMsg.audio || sentMsg.video;
            if (fileObj?.file_id) {
              saveCachedMedia({
                youtubeId,
                quality: job.quality,
                fileId: fileObj.file_id,
                fileUniqueId: fileObj.file_unique_id,
                title: mediaTitle,
                performer,
                duration: durationSeconds || fileObj.duration,
                fileSizeBytes: fileObj.file_size || result.fileSizeBytes,
                mimeType: fileObj.mime_type,
              }).catch(() => {});
            }
          }
        }
      } catch (err) {
        logger.error(
          { jobId: job.id, itemId: item.id, error: err.message },
          'Failed to deliver item to user',
        );
        // Alert user directly with the exact reason why file delivery was rejected
        await bot.api
          .sendMessage(
            chatId,
            `⚠️ *تعذر إرسال الملف إلى تيليجرام:*\n\n${escapeMarkdown(err.message)}`,
            { parse_mode: 'Markdown' },
          )
          .catch(() => {});
      } finally {
        clearInterval(actionInterval);
      }
    },

    // Notify user of item failure without aborting job
    onItemFail: async (job, item, reason) => {
      const user = await prisma.user.findUnique({ where: { id: job.userId } });
      if (!user) return;
      const chatId = Number(user.telegramId);

      try {
        await bot.api.sendMessage(
          chatId,
          `⚠️ *تعذر تحميل عنصر:*\n📌 *العنوان:* ${escapeMarkdown(item.title || '')}\n❌ *السبب:* ${escapeMarkdown(reason)}`,
          { parse_mode: 'Markdown' },
        );
      } catch (_err) {
        /* ignore message delivery errors */
      }
    },

    // Final summary message when playlist/video finishes
    onJobFinished: async (job, summary) => {
      const msgInfo = jobMessageMap.get(job.id);
      const user = await prisma.user.findUnique({ where: { id: job.userId } });
      if (!user) return;
      const chatId = Number(user.telegramId);

      let summaryText =
        `📋 *اكتملت معالجة الطلب #${job.id}!*\n\n` +
        `✅ *تم بنجاح:* ${summary.succeeded}\n` +
        `❌ *فشل:* ${summary.failed}\n` +
        `⏭️ *تم التخطي:* ${summary.skipped}`;

      if (summary.failures.length > 0) {
        summaryText += `\n\n*تفاصيل العناصر المتعثرة:*\n`;
        for (const f of summary.failures) {
          summaryText += `• ${escapeMarkdown(f.title)}: _${escapeMarkdown(f.reason)}_\n`;
        }
      }

      try {
        if (msgInfo) {
          await bot.api.editMessageText(msgInfo.chatId, msgInfo.messageId, summaryText, {
            parse_mode: 'Markdown',
          });
        } else {
          await bot.api.sendMessage(chatId, summaryText, { parse_mode: 'Markdown' });
        }
      } catch (_err) {
        /* ignore final message editing errors */
      }

      jobMessageMap.delete(job.id);
    },
  });

  // Attach worker reference for /cancel command
  bot.worker = worker;

  await worker.start();

  // Coordinated graceful shutdown
  let isShuttingDown = false;
  const shutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info({ signal }, '🛑 Shutting down gracefully...');
    await bot.stop();
    await worker.stop();
    await prisma.$disconnect();
    logger.info('👋 Goodbye!');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info('🚀 Starting bot with long polling...');
  await bot.start({
    drop_pending_updates: true,
    onStart: (botInfo) => {
      logger.info(
        { username: botInfo.username, id: botInfo.id },
        `✅ Bot @${botInfo.username} is running!`,
      );
    },
  });
}

// Export for handlers to register message IDs
module.exports = { jobMessageMap };

main().catch((err) => {
  logger.error({ error: err.message, stack: err.stack }, 'Fatal error');
  process.exit(1);
});
