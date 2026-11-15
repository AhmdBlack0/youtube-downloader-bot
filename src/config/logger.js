// @ts-check
const pino = require('pino');

/*
 * WHY PINO?
 * ---------
 * pino is the fastest JSON logger for Node.js. It writes structured JSON logs
 * (not pretty console.log strings), which means you can later pipe them into
 * tools like `pino-pretty` for development or ship them to ELK/Datadog.
 *
 * CUSTOM SERIALIZER FOR BIGINT
 * ----------------------------
 * JSON.stringify throws on BigInt values. Since Telegram user IDs are BigInt,
 * we add a custom serializer that converts them to strings before logging.
 * This is the standard pattern — you trade "it's a number" for "it doesn't crash".
 */

const logger = pino({
  level: process.env.NODE_ENV === 'test' ? 'silent' : 'info',
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
  transport:
    process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  serializers: {
    // Handle BigInt in logged objects
    ...pino.stdSerializers,
  },
  // Custom formatter to handle BigInt
  formatters: {
    log(obj) {
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = typeof value === 'bigint' ? value.toString() : value;
      }
      return result;
    },
  },
});

module.exports = { logger };
