// @ts-check

const pino = require('pino');

describe('Structured Logger & Secret Redaction (logger.js)', () => {
  test('redacts sensitive fields like botToken, token, password, and database url', () => {
    let loggedData = '';
    const destination = {
      write: (str) => {
        loggedData += str;
      },
    };

    const testLogger = pino(
      {
        redact: {
          paths: [
            'botToken',
            'BOT_TOKEN',
            'token',
            'DATABASE_URL',
            'db.url',
            'password',
            'TELEGRAM_API_HASH',
            'apiHash',
            'cookies',
            'cookiesPath',
            'COOKIES_PATH',
            '*.token',
            '*.password',
            '*.botToken',
          ],
          censor: '[REDACTED]',
        },
      },
      destination,
    );

    testLogger.info(
      {
        jobId: 42,
        botToken: '123456:secret-token-abcdef',
        password: 'super-secret-password',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      },
      'Testing secret redaction',
    );

    const parsed = JSON.parse(loggedData);

    expect(parsed.jobId).toBe(42);
    expect(parsed.botToken).toBe('[REDACTED]');
    expect(parsed.password).toBe('[REDACTED]');
    expect(parsed.DATABASE_URL).toBe('[REDACTED]');
    expect(loggedData).not.toContain('secret-token-abcdef');
    expect(loggedData).not.toContain('super-secret-password');
  });

  test('child logger includes jobId on every log entry', () => {
    const loggedLines = [];
    const destination = {
      write: (str) => {
        loggedLines.push(JSON.parse(str));
      },
    };

    const baseLogger = pino({}, destination);
    const jobLogger = baseLogger.child({ jobId: 101 });

    jobLogger.info('Starting step 1');
    jobLogger.warn('Encountered non-fatal retry');
    jobLogger.info('Finished job');

    expect(loggedLines.length).toBe(3);
    for (const line of loggedLines) {
      expect(line.jobId).toBe(101);
    }
  });
});
