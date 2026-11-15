// @ts-check

/*
 * ENTRY POINT — index.js (PHASE 5: PLAYLIST WIRING)
 * -------------------------------------------------
 * Coordinates bot, worker, per-item media delivery, throttled progress updates,
 * and final summary reports.
 */

const { InputFile } = require('grammy');
const { config, logger } = require('./config');
const { createBot } = require('./bot');
const { prisma, applyCustomIndexes } = require('./modules/db');
const { Worker } = require('./worker');
const { getYtDlpVersion } = require('./modules/downloads/ytdlp');
const { escapeMarkdown } = require('./bot/handlers/url');
const { formatBytes } = require('./utils/format');

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
  const ytDlpVersion = await getYtDlpVersion();
  logger.info({ ytDlpVersion }, '🎬 yt-dlp initialized');

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

    // Progress updates: no % or speed (only simple item indicator for playlists)
    onProgress: async (job, prog) => {
      if (prog.total <= 1) return;

      const msgInfo = jobMessageMap.get(job.id);
      if (!msgInfo) return;

      // Only edit once per playlist item to avoid Telegram rate limits & noise
      // @ts-ignore
      const cacheKey = `${job.id}_item`;
      // @ts-ignore
      if (jobMessageMap.get(cacheKey) === prog.itemIndex) return;
      // @ts-ignore
      jobMessageMap.set(cacheKey, prog.itemIndex);

      const text =
        `⏳ *جاري التحميل والمعالجة...*\n\n` +
        `📋 *العنصر ${prog.itemIndex} من ${prog.total}:* ${escapeMarkdown(prog.title)}`;

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

      let caption = `🎬 *${escapeMarkdown(item.title || result.title || 'فيديو')}*`;
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
        if (job.quality === 'mp3') {
          await bot.api.sendAudio(chatId, new InputFile(result.filePath), {
            caption,
            title: item.title || undefined,
            parse_mode: 'Markdown',
          });
        } else {
          await bot.api.sendVideo(chatId, new InputFile(result.filePath), {
            caption,
            duration: result.actualDuration || undefined,
            width: result.actualWidth || undefined,
            height: result.actualHeight || undefined,
            thumbnail: result.thumbnailPath ? new InputFile(result.thumbnailPath) : undefined,
            supports_streaming: true,
            parse_mode: 'Markdown',
          });
        }
      } catch (err) {
        logger.error(
          { jobId: job.id, itemId: item.id, error: err.message },
          'Failed to deliver item to user',
        );
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
