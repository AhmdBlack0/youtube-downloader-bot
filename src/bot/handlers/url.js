// @ts-check

/*
 * URL MESSAGE HANDLER & CALLBACK HANDLER
 * --------------------------------------
 * 1. Validates input URL strictly through parseYouTubeUrl.
 * 2. Fetches metadata safely via yt-dlp child_process.spawn.
 * 3. Enforces duration limits.
 * 4. Generates a short token, saves pending choice, and replies with inline quality buttons.
 * 5. Quality selection creates a Job (QUEUED) in PostgreSQL.
 * 6. Catches ActiveJobExistsError (P2002) and offers a Cancel button for the active job.
 * 7. Cancel handler provides race-safe cancellation.
 */

const fs = require('fs');
const path = require('path');
const { InlineKeyboard } = require('grammy');
const { config, logger } = require('../../config');
const { parseYouTubeUrl } = require('../../utils/url');
const { getMetadata } = require('../../modules/downloads/ytdlp');
const {
  createJob,
  cancelJob,
  getQueueStats,
  ActiveJobExistsError,
  DailyLimitExceededError,
} = require('../../modules/jobs/jobService');
const { createPendingChoice, getPendingChoice } = require('../../modules/pendingChoices');
const {
  buildQualityKeyboard,
  buildPlaylistSelectorKeyboard,
  PLAYLIST_PAGE_SIZE,
} = require('../keyboards/quality');
const { formatDuration, getArabicErrorMessage } = require('../../utils/format');
const { sanitizeNetscapeCookies } = require('../../utils/cookies');
const { prisma } = require('../../modules/db');
const { getCachedMedia } = require('../../modules/mediaCache');

/**
 * Fast-path metadata extractor.
 * 1. Checks MediaCache database (5ms)
 * 2. Fetches YouTube oEmbed (200-400ms)
 * 3. Falls back to full yt-dlp only if needed
 *
 * @param {import('../../utils/url').ParsedUrlResult} parsed
 * @returns {Promise<{
 *   kind: 'VIDEO'|'PLAYLIST',
 *   title: string,
 *   duration: number|null,
 *   itemCount: number,
 *   entries?: Array<{ id: string, title: string }>
 * }>}
 */
async function getFastVideoMetadata(parsed) {
  if (parsed.kind === 'PLAYLIST') {
    return getMetadata(parsed.normalizedUrl, { timeoutMs: 120000 });
  }

  // 1. Instant check in local MediaCache (takes ~5ms)
  try {
    const cached = await prisma.mediaCache.findFirst({
      where: { youtubeId: parsed.id },
      select: { title: true, duration: true },
    });
    if (cached?.title) {
      return {
        kind: 'VIDEO',
        title: cached.title,
        duration: cached.duration || null,
        itemCount: 1,
        entries: [],
      };
    }
  } catch (_e) {
    /* ignore */
  }

  // 2. Fast-path: YouTube official oEmbed API (~200ms)
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${parsed.id}&format=json`;
    const res = await globalThis.fetch(oembedUrl, {
      signal: globalThis.AbortSignal.timeout(2500),
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.title) {
        return {
          kind: 'VIDEO',
          title: data.title,
          duration: null,
          itemCount: 1,
          entries: [],
        };
      }
    }
  } catch (_e) {
    /* fallback to yt-dlp */
  }

  // 3. Fallback to full yt-dlp extraction
  return getMetadata(parsed.normalizedUrl, { timeoutMs: 35000 });
}

/**
 * Register URL and callback query handlers on the bot.
 * @param {import('grammy').Bot} bot
 */
function registerUrlHandlers(bot) {
  // Listen for text messages that are not slash commands
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();

    // Ignore commands like /start
    if (text.startsWith('/')) {
      return;
    }

    // 1. Strict URL validation
    const parsed = parseYouTubeUrl(text);
    if (!parsed.isValid || !parsed.normalizedUrl) {
      await ctx.reply(getArabicErrorMessage('INVALID_URL'));
      return;
    }

    // 2. Immediate user feedback while fetching metadata
    const statusMsg = await ctx.reply('🔍 جاري التحقق من الرابط واستخراج المعلومات...');

    try {
      // 3. Run user upsert and fast metadata extraction concurrently in parallel
      const telegramId = BigInt(ctx.from.id);
      const userPromise = prisma.user
        .upsert({
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
        })
        .catch((dbErr) => {
          logger.warn({ err: dbErr.message }, 'Could not upsert user in DB, using fallback ID');
          return { id: 1 };
        });

      const metadataPromise = getFastVideoMetadata(parsed);

      const [user, metadata] = await Promise.all([userPromise, metadataPromise]);
      const userId = user.id;

      // 4. Validate duration limit for single videos (0 = unlimited)
      if (
        metadata.kind === 'VIDEO' &&
        config.limits.maxVideoDurationSeconds > 0 &&
        metadata.duration &&
        metadata.duration > config.limits.maxVideoDurationSeconds
      ) {
        await ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          getArabicErrorMessage('DURATION_EXCEEDED', {
            duration: formatDuration(metadata.duration),
            maxDuration: formatDuration(config.limits.maxVideoDurationSeconds),
          }),
        );
        return;
      }

      // 5. Create short token & persist pending choice
      const token = await createPendingChoice({
        userId,
        url: parsed.normalizedUrl,
        kind: metadata.kind,
        title: metadata.title,
        duration: metadata.duration,
        itemCount: metadata.itemCount,
        entries: metadata.entries,
      });

      // 6. Compose preview message
      if (metadata.kind === 'VIDEO') {
        const previewText =
          `🎬 *فيديو:* ${escapeMarkdown(metadata.title)}\n` +
          `⏱️ *المدة:* ${formatDuration(metadata.duration)}\n\n` +
          `اختر الجودة المطلوبة للتحميل:`;

        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, previewText, {
          parse_mode: 'Markdown',
          reply_markup: buildQualityKeyboard(token),
        });
      } else {
        // PLAYLIST: Check if empty
        if (!metadata.entries || metadata.entries.length === 0) {
          await ctx.api.editMessageText(
            ctx.chat.id,
            statusMsg.message_id,
            '⚠️ قائمة التشغيل هذه فارغة ولا تحتوي على أي مقاطع فيديو متاحة.',
          );
          return;
        }

        const previewText = getPlaylistSelectorText(
          metadata.title,
          metadata.itemCount,
          config.limits.maxPlaylistItems,
        );

        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, previewText, {
          parse_mode: 'Markdown',
          reply_markup: buildPlaylistSelectorKeyboard(token, metadata.entries, 0),
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('❌ URL Handler Metadata error:', err.message, err.code || '');
      logger.error(
        { error: err.message, code: err.code, url: parsed.normalizedUrl },
        'Metadata error',
      );
      const errorMsg = getArabicErrorMessage(err.code || 'UNKNOWN_ERROR');
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, errorMsg).catch(() => {});
    }
  });

  // ── Playlist Callbacks ───────────────────────────────────────────

  // No-op for current page indicator button
  bot.callbackQuery('pl_noop', async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  // Playlist pagination
  bot.callbackQuery(/^pl_p:([a-f0-9]{16}):(\d+)$/, async (ctx) => {
    const [, token, pageStr] = ctx.match;
    const page = parseInt(pageStr, 10);

    const pending = await getPendingChoice(token);
    if (!pending) {
      await ctx.answerCallbackQuery({
        text: '⚠️ انتهت صلاحية هذا الرابط. يرجى إرسال الرابط مجدداً.',
        show_alert: true,
      });
      return;
    }

    const total = pending.itemCount || (pending.entries ? pending.entries.length : 0);
    const text = getPlaylistSelectorText(
      pending.title || '',
      total,
      config.limits.maxPlaylistItems,
    );
    const keyboard = buildPlaylistSelectorKeyboard(token, pending.entries || [], page);

    try {
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    } catch (_err) {
      /* ignore if message didn't change */
    }
    await ctx.answerCallbackQuery();
  });

  // Single video chosen from a playlist
  bot.callbackQuery(/^pl_v:([a-f0-9]{16}):(\d+)$/, async (ctx) => {
    const [, token, indexStr] = ctx.match;
    const index = parseInt(indexStr, 10);

    const pending = await getPendingChoice(token);
    if (!pending) {
      await ctx.answerCallbackQuery({
        text: '⚠️ انتهت صلاحية هذا الرابط. يرجى إرسال الرابط مجدداً.',
        show_alert: true,
      });
      return;
    }

    const entry = pending.entries?.[index];
    if (!entry) {
      await ctx.answerCallbackQuery({
        text: '⚠️ تعذر العثور على الفيديو المطلوب.',
        show_alert: true,
      });
      return;
    }

    // Create a new pending choice specifically for this single video
    const videoToken = await createPendingChoice({
      userId: pending.userId,
      url: `https://www.youtube.com/watch?v=${entry.id}`,
      kind: 'VIDEO',
      title: entry.title,
      duration: null,
      itemCount: 1,
    });

    const returnPage = Math.floor(index / PLAYLIST_PAGE_SIZE);
    const text =
      `🎬 *فيديو من قائمة التشغيل:*\n\n` +
      `📌 *العنوان:* ${escapeMarkdown(entry.title)}\n\n` +
      `اختر الجودة المطلوبة للتحميل:`;

    const keyboard = buildQualityKeyboard(videoToken, `pl_p:${token}:${returnPage}`);

    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
    await ctx.answerCallbackQuery();
  });

  // Download entire playlist selected
  bot.callbackQuery(/^pl_all:([a-f0-9]{16})$/, async (ctx) => {
    const [, token] = ctx.match;

    const pending = await getPendingChoice(token);
    if (!pending) {
      await ctx.answerCallbackQuery({
        text: '⚠️ انتهت صلاحية هذا الرابط. يرجى إرسال الرابط مجدداً.',
        show_alert: true,
      });
      return;
    }

    const total = pending.itemCount || (pending.entries ? pending.entries.length : 0);
    const count =
      config.limits.maxPlaylistItems > 0 ? Math.min(total, config.limits.maxPlaylistItems) : total;
    const text =
      `📋 *تحميل قائمة التشغيل كاملة:*\n\n` +
      `📌 *العنوان:* ${escapeMarkdown(pending.title || '')}\n` +
      `🔢 *عدد العناصر:* ${count} فيديو\n\n` +
      `اختر الجودة المطلوبة لتحميل القائمة بالكامل:`;

    const keyboard = buildQualityKeyboard(token, `pl_p:${token}:0`);

    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
    await ctx.answerCallbackQuery();
  });

  // Handle inline keyboard quality selection
  bot.callbackQuery(/^q:([a-f0-9]{16}):(360|480|720|1080|mp3)$/, async (ctx) => {
    const [, token, quality] = ctx.match;

    const pending = await getPendingChoice(token);
    if (!pending) {
      await ctx.answerCallbackQuery({
        text: '⚠️ انتهت صلاحية هذا الرابط. يرجى إرسال الرابط مجدداً.',
        show_alert: true,
      });
      return;
    }

    const qualityLabel = quality === 'mp3' ? 'صوت فقط (MP3)' : `${quality}p`;

    try {
      // ⚡ INSTANT DELIVERY CHECK: Check if this video is already cached in Telegram
      if (pending.kind === 'VIDEO') {
        const parsed = parseYouTubeUrl(pending.url);
        const videoId = parsed.id;
        if (videoId) {
          const cached = await getCachedMedia(videoId, quality);
          if (cached && cached.fileId && ctx.chat?.id) {
            await ctx.answerCallbackQuery({
              text: '⚡ تم العثور على الملف في الذاكرة السحابية! جاري الإرسال الفوري...',
            });

            await ctx.editMessageText(
              '⚡ *جاري الإرسال الفوري من الذاكرة السحابية (خلال ثانية واحدة)...*',
              {
                parse_mode: 'Markdown',
              },
            );

            const chatId = ctx.chat.id;
            const mediaTitle = cached.title || pending.title || 'فيديو';
            const durationSeconds = cached.duration || pending.duration || undefined;
            let caption = `🎬 *${escapeMarkdown(mediaTitle)}*`;
            if (durationSeconds) {
              caption += `\n⏱️ _المدة: ${formatDuration(durationSeconds)}_`;
            }
            caption += `\n\n⚡ _تم التسليم الفوري من الذاكرة السحابية خلال ثانية واحدة!_`;

            if (quality === 'mp3') {
              await bot.api.sendAudio(chatId, cached.fileId, {
                caption,
                title: mediaTitle,
                performer: cached.performer || 'YouTube',
                duration: durationSeconds,
                parse_mode: 'Markdown',
              });
            } else {
              await bot.api.sendVideo(chatId, cached.fileId, {
                caption,
                duration: durationSeconds,
                supports_streaming: true,
                parse_mode: 'Markdown',
              });
            }

            await ctx.editMessageText('✅ *تم إرسال الملف بنجاح في أقل من ثانية!* ⚡', {
              parse_mode: 'Markdown',
            });
            return;
          }
        }
      }
      // Prepare items records for both PLAYLIST and single VIDEO
      const maxItems =
        config.limits.maxPlaylistItems > 0 ? config.limits.maxPlaylistItems : Infinity;
      const items =
        pending.kind === 'PLAYLIST' && Array.isArray(pending.entries) && pending.entries.length > 0
          ? pending.entries.slice(0, maxItems).map((e, _idx) => ({
              title: e.title,
              videoUrl: `https://www.youtube.com/watch?v=${e.id}`,
            }))
          : [
              {
                title: pending.title || 'فيديو',
                videoUrl: pending.url,
              },
            ];

      // Create QUEUED Job in PostgreSQL
      const job = await createJob({
        userId: pending.userId,
        url: pending.url,
        kind: pending.kind,
        quality,
        items,
      });

      // Register progress message for background updates
      try {
        const { jobMessageMap } = require('../../index');
        if (jobMessageMap && ctx.chat?.id && ctx.callbackQuery.message?.message_id) {
          jobMessageMap.set(job.id, {
            chatId: ctx.chat.id,
            messageId: ctx.callbackQuery.message.message_id,
          });
        }
      } catch (_err) {
        /* ignore */
      }

      // Immediately wake worker loop to pick up this job with 0ms delay
      if (bot.worker) {
        bot.worker.wakeUp();
      }

      await ctx.answerCallbackQuery({
        text: `✅ تم إنشاء الطلب #${job.id}`,
      });

      const cancelKeyboard = new InlineKeyboard().text('❌ إلغاء الطلب', `cancel:${job.id}`);

      // Check if there are active jobs or a backlog ahead
      const stats = await getQueueStats(job.id);
      const isBusy = stats.position > 1 || stats.activeWorkers >= config.limits.maxConcurrentJobs;

      let responseText = '';
      if (isBusy) {
        responseText =
          `⏳ *أنت في قائمة الانتظار*\n\n` +
          `📌 *العنوان:* ${escapeMarkdown(pending.title || '')}\n` +
          `🎯 *الجودة:* ${qualityLabel}\n\n` +
          `سيتم البدء في التحميل تلقائياً فور توفر دورك\\.`;
      } else {
        responseText =
          `⏳ *جاري التحميل والمعالجة...*\n\n` +
          `📌 *العنوان:* ${escapeMarkdown(pending.title || '')}\n` +
          `🎯 *الجودة:* ${qualityLabel}\n\n` +
          `يرجى الانتظار، سيتم إرسال الملف فور اكتماله\\.`;
      }

      if (pending.kind === 'PLAYLIST') {
        const total = pending.itemCount || (pending.entries ? pending.entries.length : 0);
        const count =
          config.limits.maxPlaylistItems > 0
            ? Math.min(total, config.limits.maxPlaylistItems)
            : total;
        responseText += `\n\n📋 *العناصر:* ${count} فيديو (سيتم إرسال كل فيديو فور اكتماله)`;
      }

      await ctx.editMessageText(responseText, {
        parse_mode: 'Markdown',
        reply_markup: cancelKeyboard,
      });
    } catch (err) {
      if (err instanceof ActiveJobExistsError) {
        await ctx.answerCallbackQuery({
          text: '⚠️ لديك طلب نشط بالفعل!',
          show_alert: true,
        });

        const keyboard = new InlineKeyboard();
        if (err.activeJobId) {
          keyboard.text('❌ إلغاء الطلب النشط الحالي', `cancel:${err.activeJobId}`);
        }

        await ctx.editMessageText(
          `⚠️ *لديك طلب قيد التنفيذ بالفعل!*\n\n` +
            `لا يمكن إنشاء أكثر من طلب نشط واحد في نفس الوقت\\.\n` +
            `يرجى الانتظار حتى ينتهي طلبك الحالي أو إلغاؤه:`,
          {
            parse_mode: 'MarkdownV2',
            reply_markup: keyboard,
          },
        );
        return;
      }

      if (err instanceof DailyLimitExceededError) {
        await ctx.answerCallbackQuery({
          text: '🛑 تم بلوغ الحد اليومي للطلبات',
          show_alert: true,
        });

        await ctx.editMessageText(
          `🛑 *عذراً، لقد تجاوزت الحد الأقصى للطلبات اليومية (${config.limits.maxJobsPerUserPerDay} طلبات)*\\.\nيرجى المحاولة غداً\\.`,
          { parse_mode: 'MarkdownV2' },
        );
        return;
      }

      logger.error({ error: err.message }, 'Failed to create job');
      await ctx.answerCallbackQuery({ text: 'حدث خطأ أثناء إنشاء الطلب' });
      await ctx.editMessageText('⚠️ حدث خطأ غير متوقع أثناء معالجة طلبك.');
    }
  });

  // Handle job cancellation callback
  bot.callbackQuery(/^cancel:(\d+)$/, async (ctx) => {
    const jobId = parseInt(ctx.match[1], 10);
    const cancelled = await cancelJob(jobId);

    if (cancelled) {
      await ctx.answerCallbackQuery({ text: '✅ تم إلغاء الطلب بنجاح' });
      await ctx.editMessageText(`❌ *تم إلغاء الطلب #${jobId} بنجاح\\.*`, {
        parse_mode: 'MarkdownV2',
      });
    } else {
      await ctx.answerCallbackQuery({
        text: '⚠️ لم يعد بالإمكان إلغاء هذا الطلب (قد يكون اكتمل أو أُلغي بالفعل)',
        show_alert: true,
      });
    }
  });

  // Handle document upload (e.g. cookies.txt)
  bot.on(':document', async (ctx) => {
    const doc = ctx.message.document;
    if (!doc) return;

    const fileName = doc.file_name ? doc.file_name.toLowerCase() : '';
    if (fileName.includes('cookie') || fileName.endsWith('.txt')) {
      try {
        const file = await ctx.getFile();
        const fileUrl = config.telegram.apiBaseUrl
          ? `${config.telegram.apiBaseUrl}/file/bot${config.bot.token}/${file.file_path}`
          : `https://api.telegram.org/file/bot${config.bot.token}/${file.file_path}`;

        const res = await globalThis.fetch(fileUrl);
        const text = await res.text();

        if (
          text.includes('# Netscape') ||
          text.includes('.youtube.com') ||
          text.includes('LOGIN_INFO')
        ) {
          const autoCookiesFile = path.resolve(config.downloadDir, 'cookies.txt');
          fs.mkdirSync(path.dirname(autoCookiesFile), { recursive: true });
          const cleanCookies = sanitizeNetscapeCookies(text);
          fs.writeFileSync(autoCookiesFile, cleanCookies, { mode: 0o600 });
          process.env.COOKIES_PATH = autoCookiesFile;

          await ctx.reply(
            '✅ *تم حفظ وتفعيل ملف ملفات تعريف الارتباط (Cookies) بنجاح!*\n\n' +
              'سيتم استخدامه تلقائياً الآن في جميع عمليات التحميل لتجاوز التحقق الأمني من يوتيوب 🚀',
            { parse_mode: 'Markdown' },
          );
        } else {
          await ctx.reply(
            '⚠️ الملف المستلم ليس ملف تعريف ارتباط صالح لـ YouTube.\nتأكد من أن الملف بصيغة Netscape (cookies.txt).',
          );
        }
      } catch (err) {
        logger.error({ error: err.message }, 'Failed to save uploaded cookies file');
        await ctx.reply(`❌ حدث خطأ أثناء معالجة ملف الـ Cookies: ${err.message}`);
      }
    }
  });
}

/**
 * Compose message text for the playlist item selector menu.
 * @param {string} title
 * @param {number} totalCount
 * @param {number} maxAllowed
 * @returns {string}
 */
function getPlaylistSelectorText(title, totalCount, maxAllowed) {
  const isCapped = maxAllowed > 0 && totalCount > maxAllowed;
  const countInfo = isCapped
    ? `${totalCount} (⚠️ متاح تحميل أول ${maxAllowed} فيديو كحد أقصى)`
    : `${totalCount} فيديو`;

  return (
    `📋 *قائمة تشغيل:* ${escapeMarkdown(title || '')}\n` +
    `🔢 *عدد العناصر:* ${countInfo}\n\n` +
    `اضغط على أي فيديو لتحميله منفرداً، أو اختر "تحميل القائمة كاملة":`
  );
}

/**
 * Basic Markdown special character escaping for Telegram Markdown mode.
 * @param {string} text
 * @returns {string}
 */
function escapeMarkdown(text) {
  if (!text) return '';
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

module.exports = {
  registerUrlHandlers,
  escapeMarkdown,
};
