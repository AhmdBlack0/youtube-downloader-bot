// @ts-check

/*
 * URL PARSER AND VALIDATOR
 * ------------------------
 * WHY DEFENSE-IN-DEPTH?
 * Attackers will try command injection ('; rm -rf /', '$(whoami)'), SSRF,
 * phishing hostnames ('youtube.com.evil.com'), and protocol abuse ('javascript:').
 *
 * We validate in 4 strict stages:
 * 1. Length check (< 2048 chars) — prevent DoS from giant strings.
 * 2. URL class parsing — enforces valid RFC 3986 URL syntax and scheme.
 * 3. Strict hostname allowlist — exact match against known YouTube domains.
 * 4. Identifier regex extraction & canonical rebuilding:
 *    We NEVER reuse the user's raw URL string. We extract the video/playlist ID
 *    and construct a clean canonical URL from scratch (`https://www.youtube.com/watch?v=${id}`).
 */

const ALLOWED_HOSTNAMES = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'music.youtube.com',
]);

const VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;
const PLAYLIST_ID_REGEX = /^[a-zA-Z0-9_-]{12,64}$/;

/**
 * Result of URL parsing.
 * @typedef {Object} ParsedUrlResult
 * @property {boolean} isValid
 * @property {'VIDEO'|'PLAYLIST'|null} kind
 * @property {string|null} id
 * @property {string|null} normalizedUrl
 * @property {string|null} error
 */

/**
 * Parse and strictly validate a YouTube URL.
 *
 * @param {string} rawInput
 * @returns {ParsedUrlResult}
 */
function parseYouTubeUrl(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') {
    return {
      isValid: false,
      kind: null,
      id: null,
      normalizedUrl: null,
      error: 'Empty or non-string input',
    };
  }

  const trimmed = rawInput.trim();

  // 1. Guard against buffer exhaustion / ReDoS
  if (trimmed.length > 2048) {
    return {
      isValid: false,
      kind: null,
      id: null,
      normalizedUrl: null,
      error: 'URL exceeds maximum length',
    };
  }

  // 2. Parse using standard URL class
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      isValid: false,
      kind: null,
      id: null,
      normalizedUrl: null,
      error: 'Invalid URL format',
    };
  }

  // Enforce http/https only (blocks javascript:, file:, data:, etc.)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      isValid: false,
      kind: null,
      id: null,
      normalizedUrl: null,
      error: 'Unsupported protocol',
    };
  }

  // Reject credentials in URL (e.g. https://user:pass@youtube.com)
  if (parsed.username || parsed.password) {
    return {
      isValid: false,
      kind: null,
      id: null,
      normalizedUrl: null,
      error: 'URL contains credentials',
    };
  }

  // Reject non-standard ports (blocks SSRF to internal ports)
  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    return {
      isValid: false,
      kind: null,
      id: null,
      normalizedUrl: null,
      error: 'Non-standard port',
    };
  }

  // 3. Strict hostname allowlist (exact match, case-insensitive)
  const hostname = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTNAMES.has(hostname)) {
    return {
      isValid: false,
      kind: null,
      id: null,
      normalizedUrl: null,
      error: 'Host is not an allowed YouTube domain',
    };
  }

  const pathname = parsed.pathname;
  const searchParams = parsed.searchParams;

  // 4. Case A: youtu.be shortlinks (e.g., https://youtu.be/dQw4w9WgXcQ)
  if (hostname === 'youtu.be') {
    // Pathname is "/<videoId>"
    const videoId = pathname.slice(1).split('/')[0];
    if (!VIDEO_ID_REGEX.test(videoId)) {
      return {
        isValid: false,
        kind: null,
        id: null,
        normalizedUrl: null,
        error: 'Invalid video ID in youtu.be link',
      };
    }

    // Check if a playlist ID is also present in query
    const listId = searchParams.get('list');
    if (listId && PLAYLIST_ID_REGEX.test(listId) && !listId.startsWith('RD')) {
      return {
        isValid: true,
        kind: 'PLAYLIST',
        id: listId,
        normalizedUrl: `https://www.youtube.com/playlist?list=${listId}`,
        error: null,
      };
    }

    return {
      isValid: true,
      kind: 'VIDEO',
      id: videoId,
      normalizedUrl: `https://www.youtube.com/watch?v=${videoId}`,
      error: null,
    };
  }

  // Case B: Explicit Playlist URL (/playlist?list=PL...)
  if (pathname === '/playlist') {
    const listId = searchParams.get('list');
    if (!listId || !PLAYLIST_ID_REGEX.test(listId)) {
      return {
        isValid: false,
        kind: null,
        id: null,
        normalizedUrl: null,
        error: 'Invalid or missing playlist ID',
      };
    }

    return {
      isValid: true,
      kind: 'PLAYLIST',
      id: listId,
      normalizedUrl: `https://www.youtube.com/playlist?list=${listId}`,
      error: null,
    };
  }

  // Case C: Standard watch URL (/watch?v=...)
  if (pathname === '/watch') {
    const listId = searchParams.get('list');
    const videoId = searchParams.get('v');

    // If it has a playlist ID (and not a dynamic radio mix RD...)
    if (listId && PLAYLIST_ID_REGEX.test(listId) && !listId.startsWith('RD') && !videoId) {
      return {
        isValid: true,
        kind: 'PLAYLIST',
        id: listId,
        normalizedUrl: `https://www.youtube.com/playlist?list=${listId}`,
        error: null,
      };
    }

    if (videoId && VIDEO_ID_REGEX.test(videoId)) {
      // If both videoId and listId exist on /watch, check if user provided a playlist
      // If list starts with PL, prioritize playlist canonical URL, otherwise video
      if (listId && PLAYLIST_ID_REGEX.test(listId) && listId.startsWith('PL')) {
        return {
          isValid: true,
          kind: 'PLAYLIST',
          id: listId,
          normalizedUrl: `https://www.youtube.com/playlist?list=${listId}`,
          error: null,
        };
      }

      return {
        isValid: true,
        kind: 'VIDEO',
        id: videoId,
        normalizedUrl: `https://www.youtube.com/watch?v=${videoId}`,
        error: null,
      };
    }

    return {
      isValid: false,
      kind: null,
      id: null,
      normalizedUrl: null,
      error: 'Invalid or missing video ID on /watch',
    };
  }

  // Case D: Shorts (/shorts/<videoId>)
  if (pathname.startsWith('/shorts/')) {
    const videoId = pathname.replace('/shorts/', '').split('/')[0];
    if (VIDEO_ID_REGEX.test(videoId)) {
      return {
        isValid: true,
        kind: 'VIDEO',
        id: videoId,
        normalizedUrl: `https://www.youtube.com/watch?v=${videoId}`,
        error: null,
      };
    }
    return {
      isValid: false,
      kind: null,
      id: null,
      normalizedUrl: null,
      error: 'Invalid Shorts video ID',
    };
  }

  // Case E: Embeds (/embed/<videoId>)
  if (pathname.startsWith('/embed/')) {
    const videoId = pathname.replace('/embed/', '').split('/')[0];
    if (VIDEO_ID_REGEX.test(videoId)) {
      return {
        isValid: true,
        kind: 'VIDEO',
        id: videoId,
        normalizedUrl: `https://www.youtube.com/watch?v=${videoId}`,
        error: null,
      };
    }
    return {
      isValid: false,
      kind: null,
      id: null,
      normalizedUrl: null,
      error: 'Invalid embed video ID',
    };
  }

  return {
    isValid: false,
    kind: null,
    id: null,
    normalizedUrl: null,
    error: 'Unrecognized YouTube URL path',
  };
}

module.exports = {
  parseYouTubeUrl,
  ALLOWED_HOSTNAMES,
};
