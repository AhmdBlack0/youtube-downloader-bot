// @ts-check

/**
 * Format duration in seconds to human-readable HH:MM:SS or MM:SS string.
 *
 * @param {number|null} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
  if (typeof seconds !== 'number' || seconds < 0) {
    return 'غير محدد';
  }

  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const paddedMins = String(mins).padStart(2, '0');
  const paddedSecs = String(secs).padStart(2, '0');

  if (hrs > 0) {
    return `${hrs}:${paddedMins}:${paddedSecs}`;
  }
  return `${paddedMins}:${paddedSecs}`;
}

/**
 * Map error codes to user-friendly Arabic messages.
 *
 * @param {string} code
 * @param {Object} [params]
 * @returns {string}
 */
function getArabicErrorMessage(code, params = {}) {
  switch (code) {
    case 'INVALID_URL':
      return '❌ الرابط غير صالح.\nيرجى إرسال رابط صحيح لفيديو أو قائمة تشغيل من يوتيوب.';
    case 'PRIVATE_VIDEO':
      return '🔒 عذراً، هذا الفيديو أو قائمة التشغيل خاصة ولا يمكن الوصول إليها.';
    case 'DELETED_OR_UNAVAILABLE':
      return '🚫 هذا الفيديو غير متاح أو تم حذفه من قِبل الناشر.';
    case 'RESTRICTED_ACCESS':
      return '⛔ هذا المحتوى مقيد (يتطلب تسجيل دخول أو عضوية مدفوعة).';
    case 'BOT_VERIFICATION_REQUIRED':
      return '🤖 يوتيوب يطلب التحقق الأمني ("Sign in to confirm you\'re not a bot").\nيرجى تحديث أداة yt-dlp أو استخدام ملف ملفات تعريف الارتباط (Cookies).';
    case 'DURATION_EXCEEDED':
      return `⏱️ عذراً، مدة الفيديو (${params.duration || ''}) تتجاوز الحد الأقصى المسموح به (${params.maxDuration || 'ساعتان'}).`;
    case 'PLAYLIST_TOO_BIG':
      return `📋 قائمة التشغيل كبيرة جداً (${params.count} عنصر).\nالحد الأقصى المسموح به هو ${params.maxItems} عنصر.`;
    case 'NETWORK_TIMEOUT':
      return '⏳ استغرقت محاولة جلب معلومات الفيديو وقتاً طويلاً. يرجى المحاولة لاحقاً.';
    default:
      return '⚠️ حدث خطأ أثناء جلب معلومات الرابط. يرجى التحقق من الرابط والمحاولة مجدداً.';
  }
}

/**
 * Format bytes into human-readable string (KB, MB, GB).
 *
 * @param {number|BigInt} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  const num = typeof bytes === 'bigint' ? Number(bytes) : bytes;
  if (!num || num <= 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(num) / Math.log(1024));
  const val = num / Math.pow(1024, i);
  return `${val.toFixed(1)} ${units[i]}`;
}

module.exports = {
  formatDuration,
  formatBytes,
  getArabicErrorMessage,
};
