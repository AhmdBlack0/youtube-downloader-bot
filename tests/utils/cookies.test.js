// @ts-check

const { sanitizeNetscapeCookies } = require('../../src/utils/cookies');

describe('Cookies Sanitizer (cookies.js)', () => {
  test('returns empty string for null, undefined, or empty input', () => {
    // @ts-ignore
    expect(sanitizeNetscapeCookies(null)).toBe('');
    // @ts-ignore
    expect(sanitizeNetscapeCookies(undefined)).toBe('');
    expect(sanitizeNetscapeCookies('')).toBe('');
  });

  test('preserves valid 7-column Netscape lines and prepends header if missing', () => {
    const raw = '.youtube.com\tTRUE\t/\tTRUE\t1794774233\tSID\tsome_secret_token';
    const cleaned = sanitizeNetscapeCookies(raw);

    expect(cleaned).toContain('# Netscape HTTP Cookie File');
    expect(cleaned).toContain('.youtube.com\tTRUE\t/\tTRUE\t1794774233\tSID\tsome_secret_token');
  });

  test('repairs 5-column lines (missing path and secure flag)', () => {
    // The exact line reported by user:
    // WARNING: skipping cookie file entry due to invalid length 5: '\.youtube\.com\tTRUE\t0\tYSC\tSEh4r2yqiCI\n'
    const raw = '\\.youtube.com\tTRUE\t0\tYSC\tSEh4r2yqiCI';
    const cleaned = sanitizeNetscapeCookies(raw);

    expect(cleaned).toContain('.youtube.com\tTRUE\t/\tTRUE\t0\tYSC\tSEh4r2yqiCI');
  });

  test('repairs 6-column lines (missing secure flag)', () => {
    const raw = '.youtube.com\tTRUE\t/channel\t1794774233\tVISITOR_INFO1_LIVE\tabc123';
    const cleaned = sanitizeNetscapeCookies(raw);

    expect(cleaned).toContain(
      '.youtube.com\tTRUE\t/channel\tTRUE\t1794774233\tVISITOR_INFO1_LIVE\tabc123',
    );
  });

  test('drops malformed or corrupted lines with fewer than 5 or more than 7 columns', () => {
    const raw = [
      '# Netscape HTTP Cookie File',
      'invalid line with no tabs',
      'foo\tbar',
      '.youtube.com\tTRUE\t/\tTRUE\t0\tGOOD\tVAL',
      'one\ttwo\tthree\tfour\tfive\tsix\tseven\teight\tnine',
    ].join('\n');

    const cleaned = sanitizeNetscapeCookies(raw);

    expect(cleaned).toContain('.youtube.com\tTRUE\t/\tTRUE\t0\tGOOD\tVAL');
    expect(cleaned).not.toContain('invalid line with no tabs');
    expect(cleaned).not.toContain('foo\tbar');
    expect(cleaned).not.toContain('one\ttwo\tthree');
  });

  test('cleans escaped backslash in domain like \\.youtube.com', () => {
    const raw = '\\.youtube.com\tTRUE\t/\tTRUE\t1794774233\tLOGIN_INFO\txyz';
    const cleaned = sanitizeNetscapeCookies(raw);

    expect(cleaned).toContain('.youtube.com\tTRUE\t/\tTRUE\t1794774233\tLOGIN_INFO\txyz');
    expect(cleaned).not.toContain('\\.youtube.com');
  });
});
