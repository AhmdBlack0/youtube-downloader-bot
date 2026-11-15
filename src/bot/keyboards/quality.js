// @ts-check

/*
 * INLINE QUALITY KEYBOARD
 * -----------------------
 * Generates the inline keyboard buttons for quality selection.
 * Callback data pattern: `q:<shortToken>:<quality>`
 * Length is ~20-24 bytes, well within the 64-byte Telegram limit.
 */

const { InlineKeyboard } = require('grammy');

const PLAYLIST_PAGE_SIZE = 5;

/**
 * Truncate a title so it fits cleanly inside an inline button on mobile screens.
 * @param {string} str
 * @param {number} [max=35]
 * @returns {string}
 */
function truncateTitle(str, max = 35) {
  if (!str) return 'فيديو بدون عنوان';
  const clean = str.replace(/[\r\n]+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

/**
 * Build quality selection inline keyboard for a given pending choice token.
 *
 * @param {string} token 16-char short token
 * @param {string} [backCallbackData] Optional callback data for a Back button
 * @returns {InlineKeyboard}
 */
function buildQualityKeyboard(token, backCallbackData) {
  const keyboard = new InlineKeyboard()
    .text('📹 360p', `q:${token}:360`)
    .text('📹 480p', `q:${token}:480`)
    .row()
    .text('📹 720p', `q:${token}:720`)
    .text('📹 1080p', `q:${token}:1080`)
    .row()
    .text('🎵 صوت فقط (MP3)', `q:${token}:mp3`);

  if (backCallbackData) {
    keyboard.row().text('🔙 رجوع لقائمة الفيديوهات', backCallbackData);
  }

  return keyboard;
}

/**
 * Build playlist item selector keyboard with pagination and "Download All" option.
 *
 * @param {string} token 16-char short token
 * @param {Array<{ id: string, title: string }>} [entries=[]]
 * @param {number} [page=0]
 * @param {number} [pageSize=PLAYLIST_PAGE_SIZE]
 * @returns {InlineKeyboard}
 */
function buildPlaylistSelectorKeyboard(
  token,
  entries = [],
  page = 0,
  pageSize = PLAYLIST_PAGE_SIZE,
) {
  const keyboard = new InlineKeyboard();
  const totalItems = entries.length;

  // Prominent button: Download all videos
  keyboard.text(`📥 تحميل القائمة كاملة (${totalItems} فيديو)`, `pl_all:${token}`).row();

  // Slice items for current page
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * pageSize;
  const pageEntries = entries.slice(start, start + pageSize);

  for (let i = 0; i < pageEntries.length; i++) {
    const absIndex = start + i;
    const entry = pageEntries[i];
    const buttonLabel = `${absIndex + 1}. ${truncateTitle(entry.title)}`;
    keyboard.text(buttonLabel, `pl_v:${token}:${absIndex}`).row();
  }

  // Pagination navigation row (only if more than 1 page)
  if (totalPages > 1) {
    if (safePage > 0) {
      keyboard.text('◀️ السابق', `pl_p:${token}:${safePage - 1}`);
    }
    keyboard.text(`${safePage + 1} / ${totalPages}`, 'pl_noop');
    if (safePage < totalPages - 1) {
      keyboard.text('التالي ▶️', `pl_p:${token}:${safePage + 1}`);
    }
  }

  return keyboard;
}

/**
 * Build quality selection inline keyboard offering only options below current quality.
 * Used when a chosen quality exceeds the upload size limit.
 *
 * @param {string} token 16-char short token
 * @param {string} currentQuality
 * @returns {InlineKeyboard|null}
 */
function buildLowerQualityKeyboard(token, currentQuality) {
  const keyboard = new InlineKeyboard();
  const heights = [
    { label: '📹 720p', val: '720', h: 720 },
    { label: '📹 480p', val: '480', h: 480 },
    { label: '📹 360p', val: '360', h: 360 },
  ];

  const currentH = currentQuality === 'mp3' ? 0 : parseInt(currentQuality, 10);
  const eligible = heights.filter((item) => item.h < currentH);

  if (eligible.length === 0 && currentQuality !== 'mp3') {
    keyboard.text('🎵 صوت فقط (MP3)', `q:${token}:mp3`);
    return keyboard;
  }

  if (eligible.length === 0 && currentQuality === 'mp3') {
    return null; // No lower quality available
  }

  for (let i = 0; i < eligible.length; i++) {
    keyboard.text(eligible[i].label, `q:${token}:${eligible[i].val}`);
    if (i % 2 === 1) keyboard.row();
  }

  keyboard.row().text('🎵 صوت فقط (MP3)', `q:${token}:mp3`);
  return keyboard;
}

module.exports = {
  buildQualityKeyboard,
  buildLowerQualityKeyboard,
  buildPlaylistSelectorKeyboard,
  truncateTitle,
  PLAYLIST_PAGE_SIZE,
};
