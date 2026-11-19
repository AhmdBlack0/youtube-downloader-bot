// @ts-check

const EventEmitter = require('events');
const childProcess = require('child_process');
const { getMetadata, classifyYtDlpError } = require('../../src/modules/downloads/ytdlp');

// Mock child_process.spawn
jest.mock('child_process');

describe('yt-dlp Wrapper (ytdlp.js)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Helper to construct a fake child process with EventEmitter streams.
   */
  function createFakeChildProcess() {
    const child = new EventEmitter();
    // @ts-ignore
    child.stdout = new EventEmitter();
    // @ts-ignore
    child.stderr = new EventEmitter();
    // @ts-ignore
    child.kill = jest.fn();
    return child;
  }

  describe('Security Guarantees in spawn invocation', () => {
    test('MUST call spawn with an args array, shell: false, and "--" before targetUrl', async () => {
      const fakeChild = createFakeChildProcess();
      // @ts-ignore
      childProcess.spawn.mockReturnValue(fakeChild);

      const targetUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
      const promise = getMetadata(targetUrl, { binaryPath: 'yt-dlp' });

      // Simulate yt-dlp successful output
      fakeChild.stdout.emit(
        'data',
        JSON.stringify({
          _type: 'video',
          id: 'dQw4w9WgXcQ',
          title: 'Rick Astley - Never Gonna Give You Up',
          duration: 213,
        }),
      );
      fakeChild.emit('close', 0);

      const result = await promise;

      // 1. Assert child_process.spawn was called
      expect(childProcess.spawn).toHaveBeenCalledTimes(1);

      const [binary, args, options] = childProcess.spawn.mock.calls[0];

      // 2. Binary
      expect(binary).toBe('yt-dlp');

      // 3. Args MUST be an array
      expect(Array.isArray(args)).toBe(true);

      // 4. MUST include --dump-single-json, --flat-playlist, --no-warnings
      expect(args).toContain('--dump-single-json');
      expect(args).toContain('--flat-playlist');
      expect(args).toContain('--no-warnings');

      // 5. SECURITY: '--' MUST be present and immediately precede the URL
      const dashDashIndex = args.indexOf('--');
      expect(dashDashIndex).toBeGreaterThan(-1);
      expect(args[dashDashIndex + 1]).toBe(targetUrl);

      // 6. SECURITY: shell MUST be false
      expect(options.shell).toBe(false);

      // 7. Result verification
      expect(result.kind).toBe('VIDEO');
      expect(result.title).toBe('Rick Astley - Never Gonna Give You Up');
      expect(result.duration).toBe(213);
      expect(result.itemCount).toBe(1);
    });
  });

  describe('Metadata Extraction', () => {
    test('extracts playlist metadata with multiple entries', async () => {
      const fakeChild = createFakeChildProcess();
      // @ts-ignore
      childProcess.spawn.mockReturnValue(fakeChild);

      const playlistData = {
        _type: 'playlist',
        id: 'PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4',
        title: 'Lex Fridman Podcast',
        entries: [
          { id: 'item1', title: 'Episode 1' },
          { id: 'item2', title: 'Episode 2' },
          { id: 'item3', title: 'Episode 3' },
        ],
      };

      const promise = getMetadata(
        'https://www.youtube.com/playlist?list=PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4',
        {
          binaryPath: 'yt-dlp',
        },
      );

      fakeChild.stdout.emit('data', JSON.stringify(playlistData));
      fakeChild.emit('close', 0);

      const result = await promise;

      expect(result.kind).toBe('PLAYLIST');
      expect(result.title).toBe('Lex Fridman Podcast');
      expect(result.itemCount).toBe(3);
      expect(result.entries.length).toBe(3);
      expect(result.entries[0]).toEqual({ id: 'item1', title: 'Episode 1' });
    });
  });

  describe('Error Classification & Handling', () => {
    test('classifies private video error', async () => {
      const fakeChild = createFakeChildProcess();
      // @ts-ignore
      childProcess.spawn.mockReturnValue(fakeChild);

      const promise = getMetadata('https://www.youtube.com/watch?v=private1234', {
        binaryPath: 'yt-dlp',
      });

      fakeChild.stderr.emit(
        'data',
        "ERROR: [youtube] private1234: Private video. Sign in if you've been granted access.",
      );
      fakeChild.emit('close', 1);

      await expect(promise).rejects.toMatchObject({
        name: 'YtDlpError',
        code: 'PRIVATE_VIDEO',
      });
    });

    test('classifies deleted/unavailable video error', async () => {
      const fakeChild = createFakeChildProcess();
      // @ts-ignore
      childProcess.spawn.mockReturnValue(fakeChild);

      const promise = getMetadata('https://www.youtube.com/watch?v=deleted1234', {
        binaryPath: 'yt-dlp',
      });

      fakeChild.stderr.emit(
        'data',
        'ERROR: [youtube] deleted1234: Video unavailable. This video has been removed by the uploader',
      );
      fakeChild.emit('close', 1);

      await expect(promise).rejects.toMatchObject({
        name: 'YtDlpError',
        code: 'DELETED_OR_UNAVAILABLE',
      });
    });

    test('classifies restricted/members-only video error', async () => {
      const fakeChild = createFakeChildProcess();
      // @ts-ignore
      childProcess.spawn.mockReturnValue(fakeChild);

      const promise = getMetadata('https://www.youtube.com/watch?v=members1234', {
        binaryPath: 'yt-dlp',
      });

      fakeChild.stderr.emit(
        'data',
        'ERROR: Join this channel to get access to members-only content',
      );
      fakeChild.emit('close', 1);

      await expect(promise).rejects.toMatchObject({
        name: 'YtDlpError',
        code: 'RESTRICTED_ACCESS',
      });
    });

    test('classifies "Sign in to confirm you\'re not a bot" error', async () => {
      const fakeChild = createFakeChildProcess();
      // @ts-ignore
      childProcess.spawn.mockReturnValue(fakeChild);

      const promise = getMetadata('https://www.youtube.com/watch?v=botcheck123', {
        binaryPath: 'yt-dlp',
        cookiesPath: null,
      });

      fakeChild.stderr.emit(
        'data',
        'ERROR: [youtube] botcheck123: Sign in to confirm you’re not a bot. This helps protect our community.',
      );
      fakeChild.emit('close', 1);

      await expect(promise).rejects.toMatchObject({
        name: 'YtDlpError',
        code: 'BOT_VERIFICATION_REQUIRED',
      });

      // Verify classifyYtDlpError helper directly
      const classified = classifyYtDlpError("Sign in to confirm you're not a bot");
      expect(classified.code).toBe('BOT_VERIFICATION_REQUIRED');
    });

    test('handles timeout by killing the child process and rejecting with TIMEOUT', async () => {
      const fakeChild = createFakeChildProcess();
      // @ts-ignore
      childProcess.spawn.mockReturnValue(fakeChild);

      const promise = getMetadata('https://www.youtube.com/watch?v=slow1234567', {
        binaryPath: 'yt-dlp',
        timeoutMs: 50, // Short timeout for test
      });

      await expect(promise).rejects.toMatchObject({
        name: 'YtDlpError',
        code: 'TIMEOUT',
      });

      expect(fakeChild.kill).toHaveBeenCalledWith('SIGKILL');
    });

    test('handles invalid JSON output from yt-dlp', async () => {
      const fakeChild = createFakeChildProcess();
      // @ts-ignore
      childProcess.spawn.mockReturnValue(fakeChild);

      const promise = getMetadata('https://www.youtube.com/watch?v=corrupt1234', {
        binaryPath: 'yt-dlp',
      });

      fakeChild.stdout.emit('data', 'Not valid JSON');
      fakeChild.emit('close', 0);

      await expect(promise).rejects.toMatchObject({
        name: 'YtDlpError',
        code: 'JSON_PARSE_ERROR',
      });
    });
  });
});
