// @ts-check

/**
 * COOKIES SANITIZER UTILITY
 * ------------------------
 * Normalizes Netscape cookie files for yt-dlp.
 * Netscape format requires exactly 7 tab-delimited columns:
 * 1. domain (string, e.g. .youtube.com)
 * 2. include_subdomains (TRUE/FALSE)
 * 3. path (string, e.g. /)
 * 4. secure (TRUE/FALSE)
 * 5. expiration (unix timestamp or 0)
 * 6. name (cookie name)
 * 7. value (cookie value)
 *
 * Some browser extensions or export tools output 5 or 6 columns
 * (omitting path or secure flags), or escape dots (e.g. \.youtube.com).
 * This utility repairs repairable lines and silently drops malformed lines,
 * preventing yt-dlp from aborting or emitting "invalid length" warnings.
 */

/**
 * Sanitize and normalize Netscape cookies content.
 *
 * @param {string} rawContent Raw cookies string
 * @returns {string} Clean, valid Netscape cookie file content
 */
function sanitizeNetscapeCookies(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') {
    return '';
  }

  const lines = rawContent.split(/\r?\n/);
  const resultLines = [];
  let hasNetscapeHeader = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith('#')) {
      if (trimmed.toLowerCase().includes('netscape')) {
        hasNetscapeHeader = true;
      }
      resultLines.push(trimmed);
      continue;
    }

    const cols = trimmed.split('\t');

    // Clean escaped leading dots in domain if present (e.g. \.youtube.com -> .youtube.com)
    const domain = cols[0] ? cols[0].replace(/^\\+(\.)/, '$1') : '';

    if (cols.length === 7) {
      // Standard valid Netscape entry
      cols[0] = domain;
      resultLines.push(cols.join('\t'));
    } else if (cols.length === 5) {
      // Common malformed format: [domain, includeSubdomains, expiration, name, value]
      // Missing path and secure flag
      const includeSub = cols[1]?.toUpperCase() === 'FALSE' ? 'FALSE' : 'TRUE';
      const expiration = cols[2];
      const name = cols[3];
      const value = cols[4];
      resultLines.push(`${domain}\t${includeSub}\t/\tTRUE\t${expiration}\t${name}\t${value}`);
    } else if (cols.length === 6) {
      // Missing secure flag or path: [domain, includeSubdomains, path, expiration, name, value]
      const includeSub = cols[1]?.toUpperCase() === 'FALSE' ? 'FALSE' : 'TRUE';
      const path = cols[2]?.startsWith('/') ? cols[2] : '/';
      const expiration = cols[3];
      const name = cols[4];
      const value = cols[5];
      resultLines.push(`${domain}\t${includeSub}\t${path}\tTRUE\t${expiration}\t${name}\t${value}`);
    }
    // Lines with < 5 or > 7 columns are corrupted/unusable and dropped
  }

  const header = '# Netscape HTTP Cookie File\n# Sanitized by youtube-downloader-bot\n\n';
  if (!hasNetscapeHeader) {
    return header + resultLines.join('\n') + '\n';
  }

  return resultLines.join('\n') + '\n';
}

module.exports = {
  sanitizeNetscapeCookies,
};
