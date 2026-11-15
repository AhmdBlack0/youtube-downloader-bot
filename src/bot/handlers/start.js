// @ts-check

/*
 * BOT HANDLERS — /start command
 * -----------------------------
 * Handlers are functions that respond to specific Telegram events (commands,
 * messages, callback queries). Each handler is registered on the bot instance.
 *
 * We keep handlers in separate files so the bot.js file stays clean.
 * Think of it like a restaurant menu — each dish has its own recipe card,
 * and the kitchen (bot.js) just dispatches orders to the right recipe.
 */

const { prisma } = require('../../modules/db');
const { logger } = require('../../config');

/**
 * Register the /start command handler.
 * Creates or updates the user in the DB, then sends a welcome message in Arabic.
 */
function registerStartHandler(bot) {
  bot.command('start', async (ctx) => {
    const telegramId = BigInt(ctx.from.id);

    // Upsert: create user if new, update username/name if returning.
    // WHY upsert? Because the user might change their username or first name
    // between sessions. We always want the freshest data.
    await prisma.user.upsert({
      where: { telegramId },
      create: {
        telegramId,
        username: ctx.from.username || null,
        firstName: ctx.from.first_name || null,
      },
      update: {
        username: ctx.from.username || null,
        firstName: ctx.from.first_name || null,
      },
    });

    logger.info({ telegramId: telegramId.toString() }, 'User started bot');

    await ctx.reply(
      '🎬 *أهلاً بك في بوت تحميل يوتيوب\\!*\n\n' +
        'أرسل لي رابط فيديو أو قائمة تشغيل من يوتيوب وسأقوم بتحميله لك\\.\n\n' +
        '*الاستخدام:*\n' +
        '1️⃣ أرسل رابط يوتيوب\n' +
        '2️⃣ اختر الجودة المطلوبة\n' +
        '3️⃣ انتظر التحميل واستلم الملف\n\n' +
        '📌 *أوامر إضافية:*\n' +
        '• /status \\- متابعة حالة الطلب الحالي\n' +
        '• /cancel \\- إلغاء الطلب قيد التنفيذ\n\n' +
        '⚠️ الحد الأقصى لمدة الفيديو: ساعتان\n' +
        '📋 الحد الأقصى لقائمة التشغيل: 25 فيديو',
      { parse_mode: 'MarkdownV2' },
    );
  });
}

module.exports = { registerStartHandler };
