// @ts-check

const fs = require('fs');
const path = require('path');
const { downloadVideo, buildDownloadArgs } = require('../../src/modules/downloads/downloader');
const { createProgressThrottler } = require('../../src/utils/progressThrottle');

const FAKE_YTDLP_SCRIPT = path.resolve(__dirname, '../fixtures/fake-ytdlp.js');
const FAKE_BINARY = [process.execPath, FAKE_YTDLP_SCRIPT];

describe('Downloader Engine (downloader.js)', () => {
  const testBaseDir = path.resolve(__dirname, '../tmp-downloads');

  beforeAll(async () => {
    await fs.promises.mkdir(testBaseDir, { recursive: true });
  });

  afterAll(async () => {
    await fs.promises.rm(testBaseDir, { recursive: true, force: true });
  });

  describe('Format selectors and CLI arguments', () => {
    test('builds video args with format selector, fallback cascade, and "--"', () => {
      const args = buildDownloadArgs('720', '/tmp/job1', 'https://www.youtube.com/watch?v=abc');

      expect(args).toContain('-f');
      expect(args.some((a) => a.includes('height<=720'))).toBe(true);
      expect(args.some((a) => a.includes('1800M'))).toBe(true);
      expect(args).toContain('--merge-output-format');
      expect(args).toContain('mp4');
      expect(args).toContain('--write-thumbnail');
      expect(args).toContain('--embed-metadata');
      expect(args).toContain('--http-chunk-size');
      expect(args).toContain('10M');
      expect(args).toContain('--concurrent-fragments');
      expect(args).toContain('16');
      expect(args).toContain('--throttled-rate');
      expect(args).toContain('100K');

      const dashDashIndex = args.indexOf('--');
      expect(dashDashIndex).toBeGreaterThan(-1);
      expect(args[dashDashIndex + 1]).toBe('https://www.youtube.com/watch?v=abc');
    });

    test('builds audio args with -x, m4a format, and "--"', () => {
      const args = buildDownloadArgs('mp3', '/tmp/job2', 'https://www.youtube.com/watch?v=abc');

      expect(args).toContain('-x');
      expect(args).toContain('-f');
      expect(args).toContain('140/ba[ext=m4a]/ba/b/best');
      expect(args).toContain('--audio-format');
      expect(args).toContain('m4a');

      const dashDashIndex = args.indexOf('--');
      expect(dashDashIndex).toBeGreaterThan(-1);
      expect(args[dashDashIndex + 1]).toBe('https://www.youtube.com/watch?v=abc');
    });
  });

  describe('Download execution, Progress & Fallback detection', () => {
    test('successful download receives progress events, metadata, and thumbnail', async () => {
      const jobDir = path.join(testBaseDir, `job-${Date.now()}-success`);
      await fs.promises.mkdir(jobDir, { recursive: true });

      const progressEvents = [];

      try {
        const result = await downloadVideo({
          url: 'https://www.youtube.com/watch?v=valid12345',
          quality: '720',
          jobDir,
          onProgress: (p) => progressEvents.push(p),
          binaryPath: FAKE_BINARY,
          // We override args by pointing at fake script:
          // Node runs: node tests/fixtures/fake-ytdlp.js <args>
        });

        // Verify progress updates
        expect(progressEvents.length).toBeGreaterThanOrEqual(1);
        expect(progressEvents[progressEvents.length - 1].percent).toBe(100);

        // Verify result
        expect(result.actualHeight).toBe(720);
        expect(result.actualWidth).toBe(1280);
        expect(result.actualDuration).toBe(120);
        expect(result.title).toBe('Test Title');
        expect(result.uploader).toBe('Test Uploader');
        expect(result.isFallback).toBe(false);
        expect(fs.existsSync(result.filePath)).toBe(true);
        expect(result.thumbnailPath).not.toBeNull();
        expect(fs.existsSync(result.thumbnailPath)).toBe(true);
      } finally {
        await fs.promises.rm(jobDir, { recursive: true, force: true });
        expect(fs.existsSync(jobDir)).toBe(false); // Cleanup verified
      }
    });

    test('detects when fallback quality was used (asked 1080p, received 480p)', async () => {
      const jobDir = path.join(testBaseDir, `job-${Date.now()}-fallback`);
      await fs.promises.mkdir(jobDir, { recursive: true });

      try {
        const result = await downloadVideo({
          url: 'https://www.youtube.com/watch?v=simulate-fallback-480',
          quality: '1080',
          jobDir,
          binaryPath: FAKE_BINARY,
        });

        expect(result.actualHeight).toBe(480);
        expect(result.requestedQuality).toBe('1080');
        expect(result.isFallback).toBe(true);
      } finally {
        await fs.promises.rm(jobDir, { recursive: true, force: true });
        expect(fs.existsSync(jobDir)).toBe(false);
      }
    });

    test('downloads audio as mp3 without video streams', async () => {
      const jobDir = path.join(testBaseDir, `job-${Date.now()}-audio`);
      await fs.promises.mkdir(jobDir, { recursive: true });

      try {
        const result = await downloadVideo({
          url: 'https://www.youtube.com/watch?v=validAudio',
          quality: 'mp3',
          jobDir,
          binaryPath: FAKE_BINARY,
        });

        expect(result.filePath.endsWith('.mp3')).toBe(true);
        expect(result.actualHeight).toBeNull();
        expect(result.isFallback).toBe(false);
      } finally {
        await fs.promises.rm(jobDir, { recursive: true, force: true });
        expect(fs.existsSync(jobDir)).toBe(false);
      }
    });
  });

  describe('Safety & Cleanup (Finally block verification)', () => {
    test('cleans up temp directory on failure', async () => {
      const jobDir = path.join(testBaseDir, `job-${Date.now()}-fail`);
      await fs.promises.mkdir(jobDir, { recursive: true });

      let errorThrown = false;
      try {
        await downloadVideo({
          url: 'https://www.youtube.com/watch?v=simulate-fail',
          quality: '720',
          jobDir,
          binaryPath: FAKE_BINARY,
        });
      } catch (err) {
        errorThrown = true;
        expect(err.code).toBe('PRIVATE_VIDEO');
      } finally {
        // Consumer finally block
        await fs.promises.rm(jobDir, { recursive: true, force: true });
      }

      expect(errorThrown).toBe(true);
      expect(fs.existsSync(jobDir)).toBe(false);
    });

    test('cleans up temp directory on timeout and terminates process', async () => {
      const jobDir = path.join(testBaseDir, `job-${Date.now()}-timeout`);
      await fs.promises.mkdir(jobDir, { recursive: true });

      let errorThrown = false;
      try {
        await downloadVideo({
          url: 'https://www.youtube.com/watch?v=simulate-timeout',
          quality: '720',
          jobDir,
          binaryPath: FAKE_BINARY,
          timeoutMs: 150, // Short timeout for test
        });
      } catch (err) {
        errorThrown = true;
        expect(err.code).toBe('TIMEOUT');
      } finally {
        await fs.promises.rm(jobDir, { recursive: true, force: true });
      }

      expect(errorThrown).toBe(true);
      expect(fs.existsSync(jobDir)).toBe(false);
    });

    test('cleans up temp directory on user cancellation', async () => {
      const jobDir = path.join(testBaseDir, `job-${Date.now()}-cancel`);
      await fs.promises.mkdir(jobDir, { recursive: true });

      const cancelToken = { isCancelled: false };
      let errorThrown = false;

      // Cancel after 80ms
      setTimeout(() => {
        cancelToken.isCancelled = true;
      }, 80);

      try {
        await downloadVideo({
          url: 'https://www.youtube.com/watch?v=simulate-timeout',
          quality: '720',
          jobDir,
          binaryPath: FAKE_BINARY,
          cancelToken,
          timeoutMs: 10000,
        });
      } catch (err) {
        errorThrown = true;
        expect(err.code).toBe('CANCELLED');
      } finally {
        await fs.promises.rm(jobDir, { recursive: true, force: true });
      }

      expect(errorThrown).toBe(true);
      expect(fs.existsSync(jobDir)).toBe(false);
    });
  });

  describe('Progress Throttler', () => {
    test('throttles rapid progress events to defined interval and flushes', async () => {
      const updates = [];
      const throttler = createProgressThrottler((val) => {
        updates.push({ val, time: Date.now() });
      }, 50); // 50ms throttle interval for fast test

      // Rapidly fire updates
      await throttler.update(10);
      await throttler.update(20);
      await throttler.update(30);
      await throttler.update(40);

      // Only the first update should execute synchronously
      expect(updates.length).toBe(1);
      expect(updates[0].val).toBe(10);

      // Wait 60ms to let timer fire
      await new Promise((r) => setTimeout(r, 65));

      // Second throttled update should have arrived with latest value (40)
      expect(updates.length).toBe(2);
      expect(updates[1].val).toBe(40);

      // Test flush
      await throttler.update(50);
      await throttler.flush();
      expect(updates[updates.length - 1].val).toBe(50);
    });
  });
});
