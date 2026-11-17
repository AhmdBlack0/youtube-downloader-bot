// @ts-check

const { getCachedMedia, saveCachedMedia } = require('../../src/modules/mediaCache');

describe('MediaCache Module (Telegram file_id Caching)', () => {
  const testYtId = `test_yt_${Date.now()}`;

  test('returns null for non-existent cache entry', async () => {
    const cached = await getCachedMedia('non_existent_id', 'mp3');
    expect(cached).toBeNull();
  });

  test('saves and retrieves cached media by youtubeId and quality', async () => {
    const entry = {
      youtubeId: testYtId,
      quality: 'mp3',
      fileId: 'CQACAgQAAxkBAAIC_test_file_id_123',
      fileUniqueId: 'unique_id_123',
      title: 'Amazing Test Song',
      performer: 'Famous Artist',
      duration: 215,
      fileSizeBytes: 3500000,
      mimeType: 'audio/mpeg',
    };

    const saved = await saveCachedMedia(entry);
    expect(saved).not.toBeNull();
    expect(saved?.youtubeId).toBe(testYtId);
    expect(saved?.quality).toBe('mp3');
    expect(saved?.fileId).toBe(entry.fileId);

    // Retrieve
    const retrieved = await getCachedMedia(testYtId, 'mp3');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.fileId).toBe(entry.fileId);
    expect(retrieved?.title).toBe('Amazing Test Song');
    expect(retrieved?.performer).toBe('Famous Artist');
    expect(retrieved?.duration).toBe(215);
  });

  test('updates existing cache entry on repeated save (upsert behavior)', async () => {
    const updated = await saveCachedMedia({
      youtubeId: testYtId,
      quality: 'mp3',
      fileId: 'CQACAgQAAxkBAAIC_updated_file_id_456',
      title: 'Updated Title',
    });

    expect(updated).not.toBeNull();
    expect(updated?.fileId).toBe('CQACAgQAAxkBAAIC_updated_file_id_456');
    expect(updated?.title).toBe('Updated Title');

    const retrieved = await getCachedMedia(testYtId, 'mp3');
    expect(retrieved?.fileId).toBe('CQACAgQAAxkBAAIC_updated_file_id_456');
    expect(retrieved?.title).toBe('Updated Title');
  });

  test('separates different qualities for the same video', async () => {
    await saveCachedMedia({
      youtubeId: testYtId,
      quality: '720',
      fileId: 'BAACAgQAAxkBAAIC_video_720_file_id',
    });

    const audioCache = await getCachedMedia(testYtId, 'mp3');
    const videoCache = await getCachedMedia(testYtId, '720');

    expect(audioCache?.fileId).toBe('CQACAgQAAxkBAAIC_updated_file_id_456');
    expect(videoCache?.fileId).toBe('BAACAgQAAxkBAAIC_video_720_file_id');
  });

  test('gracefully returns null for invalid inputs', async () => {
    // @ts-ignore
    expect(await getCachedMedia(null, 'mp3')).toBeNull();
    // @ts-ignore
    expect(await saveCachedMedia({})).toBeNull();
    // @ts-ignore
    expect(await saveCachedMedia({ youtubeId: 'abc' })).toBeNull();
  });
});
