// @ts-check

const { parseYouTubeUrl } = require('../../src/utils/url');

describe('YouTube URL Parser & Validator (url.js)', () => {
  describe('Valid YouTube Video URLs', () => {
    test('standard watch URL (www.youtube.com)', () => {
      const res = parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      expect(res.isValid).toBe(true);
      expect(res.kind).toBe('VIDEO');
      expect(res.id).toBe('dQw4w9WgXcQ');
      expect(res.normalizedUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      expect(res.error).toBeNull();
    });

    test('apex domain watch URL (youtube.com)', () => {
      const res = parseYouTubeUrl('https://youtube.com/watch?v=jNQXAC9IVRw');
      expect(res.isValid).toBe(true);
      expect(res.kind).toBe('VIDEO');
      expect(res.id).toBe('jNQXAC9IVRw');
      expect(res.normalizedUrl).toBe('https://www.youtube.com/watch?v=jNQXAC9IVRw');
    });

    test('mobile domain watch URL (m.youtube.com)', () => {
      const res = parseYouTubeUrl('https://m.youtube.com/watch?v=dQw4w9WgXcQ');
      expect(res.isValid).toBe(true);
      expect(res.kind).toBe('VIDEO');
      expect(res.normalizedUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    });

    test('music domain watch URL (music.youtube.com)', () => {
      const res = parseYouTubeUrl('https://music.youtube.com/watch?v=dQw4w9WgXcQ');
      expect(res.isValid).toBe(true);
      expect(res.kind).toBe('VIDEO');
      expect(res.normalizedUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    });

    test('youtu.be shortlink', () => {
      const res = parseYouTubeUrl('https://youtu.be/dQw4w9WgXcQ');
      expect(res.isValid).toBe(true);
      expect(res.kind).toBe('VIDEO');
      expect(res.id).toBe('dQw4w9WgXcQ');
      expect(res.normalizedUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    });

    test('YouTube Shorts URL', () => {
      const res = parseYouTubeUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ');
      expect(res.isValid).toBe(true);
      expect(res.kind).toBe('VIDEO');
      expect(res.id).toBe('dQw4w9WgXcQ');
      expect(res.normalizedUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    });

    test('YouTube Embed URL', () => {
      const res = parseYouTubeUrl('https://www.youtube.com/embed/dQw4w9WgXcQ');
      expect(res.isValid).toBe(true);
      expect(res.kind).toBe('VIDEO');
      expect(res.id).toBe('dQw4w9WgXcQ');
      expect(res.normalizedUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    });

    test('watch URL with additional query params strips tracking/timestamps in normalizedUrl', () => {
      const res = parseYouTubeUrl(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&feature=share',
      );
      expect(res.isValid).toBe(true);
      expect(res.kind).toBe('VIDEO');
      expect(res.id).toBe('dQw4w9WgXcQ');
      // Must be clean canonical URL
      expect(res.normalizedUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    });
  });

  describe('Valid YouTube Playlist URLs', () => {
    test('explicit playlist URL (/playlist?list=PL...)', () => {
      const res = parseYouTubeUrl(
        'https://www.youtube.com/playlist?list=PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4',
      );
      expect(res.isValid).toBe(true);
      expect(res.kind).toBe('PLAYLIST');
      expect(res.id).toBe('PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4');
      expect(res.normalizedUrl).toBe(
        'https://www.youtube.com/playlist?list=PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4',
      );
    });

    test('watch URL with embedded PL playlist', () => {
      const res = parseYouTubeUrl(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4',
      );
      expect(res.isValid).toBe(true);
      expect(res.kind).toBe('PLAYLIST');
      expect(res.id).toBe('PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4');
      expect(res.normalizedUrl).toBe(
        'https://www.youtube.com/playlist?list=PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4',
      );
    });

    test('youtu.be shortlink with playlist query param', () => {
      const res = parseYouTubeUrl(
        'https://youtu.be/dQw4w9WgXcQ?list=PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4',
      );
      expect(res.isValid).toBe(true);
      expect(res.kind).toBe('PLAYLIST');
      expect(res.id).toBe('PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4');
      expect(res.normalizedUrl).toBe(
        'https://www.youtube.com/playlist?list=PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4',
      );
    });
  });

  describe('Malicious & Invalid Inputs Rejection', () => {
    test('rejects subdomain phishing / evil domain: https://youtube.com.evil.com/...', () => {
      const res = parseYouTubeUrl('https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ');
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('Host is not an allowed YouTube domain');
    });

    test('rejects shell command injection string: ; rm -rf /', () => {
      const res = parseYouTubeUrl('; rm -rf /');
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('Invalid URL format');
    });

    test('rejects shell expansion string: $(whoami)', () => {
      const res = parseYouTubeUrl('$(whoami)');
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('Invalid URL format');
    });

    test('rejects shell pipe and backtick injection: `cat /etc/passwd`', () => {
      const res = parseYouTubeUrl('`cat /etc/passwd`');
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('Invalid URL format');
    });

    test('rejects URLs containing spaces', () => {
      const res = parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w 9WgXcQ');
      expect(res.isValid).toBe(false);
    });

    test('rejects javascript: scheme (XSS vector)', () => {
      const res = parseYouTubeUrl('javascript:alert(1)');
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('Unsupported protocol');
    });

    test('rejects file:// scheme (LFI vector)', () => {
      const res = parseYouTubeUrl('file:///etc/passwd');
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('Unsupported protocol');
    });

    test('rejects data: scheme', () => {
      const res = parseYouTubeUrl('data:text/html,<script>alert(1)</script>');
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('Unsupported protocol');
    });

    test('rejects very long strings (> 2048 chars) preventing DoS', () => {
      const giantString = 'https://www.youtube.com/watch?v=' + 'a'.repeat(3000);
      const res = parseYouTubeUrl(giantString);
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('URL exceeds maximum length');
    });

    test('rejects URLs with embedded user credentials', () => {
      const res = parseYouTubeUrl('https://attacker:secret@www.youtube.com/watch?v=dQw4w9WgXcQ');
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('URL contains credentials');
    });

    test('rejects non-standard ports (SSRF protection)', () => {
      const res = parseYouTubeUrl('https://www.youtube.com:8080/watch?v=dQw4w9WgXcQ');
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('Non-standard port');
    });

    test('rejects empty, null, or non-string inputs', () => {
      expect(parseYouTubeUrl('').isValid).toBe(false);
      // @ts-ignore
      expect(parseYouTubeUrl(null).isValid).toBe(false);
      // @ts-ignore
      expect(parseYouTubeUrl(undefined).isValid).toBe(false);
      // @ts-ignore
      expect(parseYouTubeUrl(12345).isValid).toBe(false);
    });

    test('rejects completely unrelated websites (e.g. vimeo, google)', () => {
      expect(parseYouTubeUrl('https://vimeo.com/123456').isValid).toBe(false);
      expect(parseYouTubeUrl('https://google.com').isValid).toBe(false);
    });

    test('rejects invalid video ID formats (not 11 chars base64url)', () => {
      expect(parseYouTubeUrl('https://www.youtube.com/watch?v=too_short').isValid).toBe(false);
      expect(
        parseYouTubeUrl('https://www.youtube.com/watch?v=way_too_long_to_be_a_valid_id').isValid,
      ).toBe(false);
      expect(parseYouTubeUrl('https://www.youtube.com/watch?v=invalid!char').isValid).toBe(false);
    });
  });
});
