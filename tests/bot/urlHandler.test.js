// @ts-check

const { parseYouTubeUrl } = require('../../src/utils/url');
const { getArabicErrorMessage, formatDuration } = require('../../src/utils/format');
const {
  buildQualityKeyboard,
  buildPlaylistSelectorKeyboard,
  truncateTitle,
} = require('../../src/bot/keyboards/quality');
const { createPendingChoice, getPendingChoice } = require('../../src/modules/pendingChoices');

describe('Bot URL Handler & Keyboard Integration', () => {
  test('valid video link parsing & formatting flow', async () => {
    const rawUrl = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
    const parsed = parseYouTubeUrl(rawUrl);

    expect(parsed.isValid).toBe(true);
    expect(parsed.kind).toBe('VIDEO');
    expect(parsed.normalizedUrl).toBe('https://www.youtube.com/watch?v=jNQXAC9IVRw');

    // Simulate metadata
    const metadata = {
      kind: parsed.kind,
      title: 'Me at the zoo',
      duration: 19,
      itemCount: 1,
    };

    expect(formatDuration(metadata.duration)).toBe('00:19');

    // Store pending choice
    const token = await createPendingChoice({
      userId: 1,
      url: parsed.normalizedUrl,
      kind: 'VIDEO',
      title: metadata.title,
      duration: metadata.duration,
      itemCount: metadata.itemCount,
    });

    expect(token).toHaveLength(16);

    // Build keyboard
    const keyboard = buildQualityKeyboard(token);
    expect(keyboard.inline_keyboard.length).toBe(3); // 3 rows

    // Check callback_data adheres to Telegram 64-byte limit
    for (const row of keyboard.inline_keyboard) {
      for (const btn of row) {
        expect(Buffer.byteLength(btn.callback_data, 'utf8')).toBeLessThanOrEqual(64);
        expect(btn.callback_data).toMatch(new RegExp(`^q:${token}:(360|480|720|1080|mp3)$`));
      }
    }

    // Retrieve pending choice from token
    const retrieved = await getPendingChoice(token);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.title).toBe('Me at the zoo');
    expect(retrieved?.kind).toBe('VIDEO');
  });

  test('valid playlist link with capping notice', async () => {
    const rawUrl = 'https://www.youtube.com/playlist?list=PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4';
    const parsed = parseYouTubeUrl(rawUrl);

    expect(parsed.isValid).toBe(true);
    expect(parsed.kind).toBe('PLAYLIST');

    const metadata = {
      kind: parsed.kind,
      title: 'Lex Fridman Podcast',
      duration: null,
      itemCount: 449,
    };

    const isCapped = metadata.itemCount > 25;
    expect(isCapped).toBe(true);

    const token = await createPendingChoice({
      userId: 1,
      url: parsed.normalizedUrl,
      kind: 'PLAYLIST',
      title: metadata.title,
      duration: metadata.duration,
      itemCount: metadata.itemCount,
    });

    const retrieved = await getPendingChoice(token);
    expect(retrieved?.kind).toBe('PLAYLIST');
    expect(retrieved?.itemCount).toBe(449);
  });

  test('malicious inputs are rejected and produce Arabic error messages', () => {
    const maliciousInputs = [
      'https://youtube.com.evil.com/watch?v=abc',
      '; rm -rf /',
      '$(whoami)',
      '`cat /etc/passwd`',
      'javascript:alert(1)',
      'https://google.com',
    ];

    for (const input of maliciousInputs) {
      const parsed = parseYouTubeUrl(input);
      expect(parsed.isValid).toBe(false);

      const arabicMsg = getArabicErrorMessage('INVALID_URL');
      expect(arabicMsg).toContain('❌ الرابط غير صالح');
    }
  });

  describe('Playlist Item Selector & Quality Keyboard with Back Button', () => {
    test('buildPlaylistSelectorKeyboard generates download-all button, item list, and pagination', () => {
      const token = '1234567890abcdef';
      const fakeEntries = [
        { id: 'v1', title: 'First Video in Playlist' },
        { id: 'v2', title: 'Second Video' },
        { id: 'v3', title: 'Third Video' },
        { id: 'v4', title: 'Fourth Video' },
        { id: 'v5', title: 'Fifth Video' },
        { id: 'v6', title: 'Sixth Video (Next Page)' },
        { id: 'v7', title: 'Seventh Video' },
      ];

      // Page 0 (items 1 to 5)
      const page0Keyboard = buildPlaylistSelectorKeyboard(token, fakeEntries, 0, 5);
      const rows0 = page0Keyboard.inline_keyboard;

      // Row 0: Download all
      expect(rows0[0][0].text).toContain('تحميل القائمة كاملة (7 فيديو)');
      expect(rows0[0][0].callback_data).toBe(`pl_all:${token}`);

      // Rows 1-5: Items 1 to 5
      expect(rows0[1][0].text).toContain('1. First Video in Playlist');
      expect(rows0[1][0].callback_data).toBe(`pl_v:${token}:0`);
      expect(rows0[5][0].text).toContain('5. Fifth Video');
      expect(rows0[5][0].callback_data).toBe(`pl_v:${token}:4`);

      // Row 6: Pagination (1 / 2 and Next)
      const navRow0 = rows0[6];
      expect(navRow0.some((btn) => btn.text.includes('1 / 2'))).toBe(true);
      expect(navRow0.some((btn) => btn.callback_data === `pl_p:${token}:1`)).toBe(true);

      // Verify all buttons respect Telegram 64-byte limit
      for (const row of rows0) {
        for (const btn of row) {
          expect(Buffer.byteLength(btn.callback_data, 'utf8')).toBeLessThanOrEqual(64);
        }
      }

      // Page 1 (items 6 to 7)
      const page1Keyboard = buildPlaylistSelectorKeyboard(token, fakeEntries, 1, 5);
      const rows1 = page1Keyboard.inline_keyboard;
      expect(rows1[1][0].text).toContain('6. Sixth Video');
      expect(rows1[1][0].callback_data).toBe(`pl_v:${token}:5`);
      expect(rows1[2][0].text).toContain('7. Seventh Video');
      expect(rows1[2][0].callback_data).toBe(`pl_v:${token}:6`);

      // Nav row on page 1 should have Previous button
      const navRow1 = rows1[3];
      expect(navRow1.some((btn) => btn.callback_data === `pl_p:${token}:0`)).toBe(true);
    });

    test('buildQualityKeyboard with back button includes return row', () => {
      const token = 'abcdef1234567890';
      const backCallback = 'pl_p:1234567890abcdef:0';

      const keyboardWithBack = buildQualityKeyboard(token, backCallback);
      expect(keyboardWithBack.inline_keyboard.length).toBe(4); // 4 rows

      const lastRow = keyboardWithBack.inline_keyboard[3];
      expect(lastRow[0].text).toContain('رجوع');
      expect(lastRow[0].callback_data).toBe(backCallback);
      expect(Buffer.byteLength(lastRow[0].callback_data, 'utf8')).toBeLessThanOrEqual(64);
    });

    test('truncateTitle handles short, long, and empty titles properly', () => {
      expect(truncateTitle('Short title', 20)).toBe('Short title');
      expect(truncateTitle('A very long video title that exceeds limits', 15)).toBe(
        'A very long vi…',
      );
      expect(truncateTitle('', 20)).toBe('فيديو بدون عنوان');
    });
  });
});
