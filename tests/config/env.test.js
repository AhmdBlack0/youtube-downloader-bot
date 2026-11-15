// @ts-check

/*
 * TESTS FOR: src/config/env.js
 *
 * STRATEGY:
 * We test the Zod validation by manipulating process.env BEFORE requiring
 * the config module. This is tricky because Node.js caches require() calls.
 * So we use jest.resetModules() to clear the cache between tests.
 *
 * WHY TEST CONFIG VALIDATION?
 * Because a typo in .env (e.g., MAX_CONCURRENT_JOBS=abc) should crash on
 * startup, not at 3 AM when a user sends a link. These tests prove that.
 */

// Minimum valid env vars — the smallest set that passes validation
const validEnv = {
  BOT_TOKEN: 'test-token-123',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/testdb',
  ALLOWED_USER_IDS: '123456789',
  NODE_ENV: 'test',
};

// Helper: set env, clear module cache, and require config fresh
function loadConfigWith(envOverrides) {
  // Reset module cache so config/env.js re-executes
  jest.resetModules();

  // Clear ALL env vars that our schema cares about, then apply overrides.
  // This prevents test pollution from the real .env or previous tests.
  const keysToClean = [
    'BOT_TOKEN',
    'DATABASE_URL',
    'ALLOWED_USER_IDS',
    'TELEGRAM_API_ID',
    'TELEGRAM_API_HASH',
    'TELEGRAM_API_BASE_URL',
    'MAX_CONCURRENT_JOBS',
    'MAX_JOBS_PER_USER_PER_DAY',
    'MAX_PLAYLIST_ITEMS',
    'MAX_VIDEO_DURATION_SECONDS',
    'MAX_FILE_SIZE_BYTES',
    'JOB_TIMEOUT_SECONDS',
    'MIN_DISK_SPACE_BYTES',
    'DOWNLOAD_DIR',
    'NODE_ENV',
  ];

  for (const key of keysToClean) {
    delete process.env[key];
  }

  for (const [key, val] of Object.entries(envOverrides)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }

  // Mock process.exit so it doesn't actually kill the test runner
  const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit called');
  });

  let config;
  let error;
  try {
    config = require('../../src/config/env').config;
  } catch (e) {
    error = e;
  }

  mockExit.mockRestore();
  return { config, error };
}

describe('Config validation (env.js)', () => {
  let originalEnv;

  beforeAll(() => {
    originalEnv = { ...process.env };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('valid env → config object with correct values', () => {
    const { config, error } = loadConfigWith(validEnv);
    expect(error).toBeUndefined();
    expect(config.bot.token).toBe('test-token-123');
    expect(config.db.url).toBe('postgresql://user:pass@localhost:5432/testdb');
    expect(config.allowedUserIds).toEqual([BigInt(123456789)]);
  });

  test('multiple ALLOWED_USER_IDS are parsed as BigInt array', () => {
    const { config } = loadConfigWith({
      ...validEnv,
      ALLOWED_USER_IDS: '111,222,333',
    });
    expect(config.allowedUserIds).toEqual([BigInt(111), BigInt(222), BigInt(333)]);
  });

  test('defaults are applied when optional vars are missing', () => {
    const { config } = loadConfigWith(validEnv);
    expect(config.limits.maxConcurrentJobs).toBe(2);
    expect(config.limits.maxPlaylistItems).toBe(0);
    expect(config.limits.maxVideoDurationSeconds).toBe(7200);
    expect(config.limits.maxFileSizeBytes).toBe(2_147_483_648);
  });

  test('missing BOT_TOKEN → process.exit(1)', () => {
    const { error } = loadConfigWith({
      ...validEnv,
      BOT_TOKEN: undefined,
    });
    expect(error).toBeDefined();
    expect(error.message).toBe('process.exit called');
  });

  test('missing DATABASE_URL → process.exit(1)', () => {
    const { error } = loadConfigWith({
      ...validEnv,
      DATABASE_URL: undefined,
    });
    expect(error).toBeDefined();
  });

  test('missing ALLOWED_USER_IDS → process.exit(1)', () => {
    const { error } = loadConfigWith({
      ...validEnv,
      ALLOWED_USER_IDS: undefined,
    });
    expect(error).toBeDefined();
  });

  test('non-numeric MAX_CONCURRENT_JOBS → process.exit(1)', () => {
    const { error } = loadConfigWith({
      ...validEnv,
      MAX_CONCURRENT_JOBS: 'abc',
    });
    expect(error).toBeDefined();
  });

  test('custom limits override defaults', () => {
    const { config } = loadConfigWith({
      ...validEnv,
      MAX_CONCURRENT_JOBS: '5',
      MAX_PLAYLIST_ITEMS: '50',
    });
    expect(config.limits.maxConcurrentJobs).toBe(5);
    expect(config.limits.maxPlaylistItems).toBe(50);
  });

  test('TELEGRAM_API_BASE_URL must be a valid URL if provided', () => {
    const { error } = loadConfigWith({
      ...validEnv,
      TELEGRAM_API_BASE_URL: 'not-a-url',
    });
    expect(error).toBeDefined();
  });

  test('valid TELEGRAM_API_BASE_URL is accepted', () => {
    const { config } = loadConfigWith({
      ...validEnv,
      TELEGRAM_API_BASE_URL: 'http://localhost:8081',
    });
    expect(config.telegram.apiBaseUrl).toBe('http://localhost:8081');
  });
});
