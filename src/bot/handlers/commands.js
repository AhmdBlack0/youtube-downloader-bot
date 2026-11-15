// @ts-check

/*
 * BOT COMMAND HANDLERS: /status and /cancel
 * -----------------------------------------
 * Allows users to inspect their active job status or abort an in-flight job.
 */

const { InlineKeyboard } = require('grammy');
const { prisma } = require('../../modules/db');
const { cancelJob } = require('../../modules/jobs/jobService');
const { escapeMarkdown } = require('./url');

/**
 * Register /status and /cancel command handlers on the bot.
 *
 * @param {import('grammy').Bot} bot
 * @param {Object} [options]
 * @param {import('../../worker').Worker} [options.worker]
 */
function registerCommandHandlers(bot, options = {}) {
  // ── /status Command ───────────────────────────────────────────
  bot.command('status', async (ctx) => {
    const telegramId = BigInt(ctx.from.id);

    const user = await prisma.user.findUnique({
      where: { telegramId },
    });

    if (!user) {
      await ctx.reply('ℹ️ لا يوجد لديك أي طلب نشط حالياً.\nأرسل رابط يوتيوب لبدء التحميل.');
      return;
    }

    const activeJob = await prisma.job.findFirst({
      where: {
        userId: user.id,
        status: { in: ['QUEUED', 'RUNNING'] },
      },
      include: {
        items: {
          orderBy: { index: 'asc' },
        },
      },
    });

    if (!activeJob) {
      await ctx.reply('ℹ️ لا يوجد لديك أي طلب نشط حالياً.\nأرسل رابط يوتيوب لبدء التحميل.');
      return;
    }

    const statusLabel =
      activeJob.status === 'QUEUED' ? '⏳ في قائمة الانتظار' : '⚙️ قيد التحميل والمعالجة حالياً';

    const qualityLabel = activeJob.quality === 'mp3' ? 'صوت MP3' : `${activeJob.quality}p`;

    const kindLabel = activeJob.kind === 'PLAYLIST' ? 'قائمة تشغيل 📋' : 'فيديو فردي 🎬';

    let text =
      `📊 *حالة طلبك الحالي #${activeJob.id}:*\n\n` +
      `📌 *النوع:* ${kindLabel}\n` +
      `🎯 *الجودة:* ${qualityLabel}\n` +
      `🔄 *الحالة:* ${statusLabel}\n`;

    if (activeJob.kind === 'PLAYLIST' && activeJob.items.length > 0) {
      const total = activeJob.items.length;
      const done = activeJob.items.filter((i) => i.status === 'DONE').length;
      const failed = activeJob.items.filter((i) => i.status === 'FAILED').length;
      const downloading = activeJob.items.find((i) => i.status === 'DOWNLOADING');

      text += `\n📋 *تقدم عناصر القائمة:*\n`;
      text += `• المكتمل: ${done}/${total}\n`;
      if (failed > 0) text += `• المتعثر: ${failed}\n`;
      if (downloading) {
        text += `• العنصر الجاري: ${escapeMarkdown(downloading.title || `عنصر ${downloading.index + 1}`)}\n`;
      }
    }

    const keyboard = new InlineKeyboard().text('❌ إلغاء الطلب', `cancel:${activeJob.id}`);

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  });

  // ── /cancel Command ───────────────────────────────────────────
  bot.command('cancel', async (ctx) => {
    const telegramId = BigInt(ctx.from.id);

    const user = await prisma.user.findUnique({
      where: { telegramId },
    });

    if (!user) {
      await ctx.reply('ℹ️ لا يوجد لديك أي طلب نشط لإلغائه.');
      return;
    }

    const activeJob = await prisma.job.findFirst({
      where: {
        userId: user.id,
        status: { in: ['QUEUED', 'RUNNING'] },
      },
    });

    if (!activeJob) {
      await ctx.reply('ℹ️ لا يوجد لديك أي طلب نشط لإلغائه.');
      return;
    }

    // Cancel in database
    const cancelled = await cancelJob(activeJob.id);

    // Cancel in-memory worker process if active
    const activeWorker = options.worker || bot.worker;
    if (activeWorker) {
      activeWorker.cancel(activeJob.id);
    }

    if (cancelled) {
      await ctx.reply(`✅ تم إلغاء طلبك #${activeJob.id} بنجاح.`);
    } else {
      await ctx.reply('⚠️ تعذر إلغاء الطلب (قد يكون اكتمل أو أُلغي بالفعل).');
    }
  });
}

module.exports = { registerCommandHandlers };
