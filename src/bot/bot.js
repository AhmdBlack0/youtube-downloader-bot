// @ts-check

/*
 * BOT SETUP — the central wiring file
 * ------------------------------------
 * This file creates the grammY Bot instance, attaches middleware and handlers,
 * and exports a function to start polling.
 *
 * WHY SEPARATE FROM index.js?
 * Because index.js is the "entry point" that orchestrates everything (DB, bot,
 * worker, shutdown). bot.js only knows about the bot. Separation of concerns.
 *
 * LONG POLLING explained:
 * bot.start() calls Telegram's getUpdates endpoint in an infinite loop.
 * Each call says "give me messages since offset X" and blocks until Telegram
 * has something (or times out after ~30 seconds). When messages arrive,
 * grammY dispatches them to your middleware chain, then requests again.
 * No public server, no SSL certificate, works behind NAT.
 */

const { Bot } = require('grammy');
const { autoRetry } = require('@grammyjs/auto-retry');
const { config, logger } = require('../config');
const { allowlistMiddleware } = require('./middleware');
const {
  registerStartHandler,
  registerUrlHandlers,
  registerCommandHandlers,
} = require('./handlers');

function createBot(options = {}) {
  // If a local Bot API server URL is configured, point grammY at it.
  // Otherwise, grammY defaults to https://api.telegram.org.
  //
  // WHY buildUrl + getPath CUSTOMIZATION?
  // The local Bot API server uses a slightly different URL structure:
  //   Cloud:   https://api.telegram.org/bot<token>/sendMessage
  //   Local:   http://localhost:8081/bot<token>/sendMessage
  // grammY's `client.apiRoot` option handles this for us.
  const botOptions = {};

  if (config.telegram.apiBaseUrl) {
    botOptions.client = {
      apiRoot: config.telegram.apiBaseUrl,
    };
  }

  const bot = new Bot(config.bot.token, botOptions);

  // --- Resiliency: Auto-retry on Telegram HTTP 429 FLOOD_WAIT ---
  bot.api.config.use(
    autoRetry({
      maxRetryAttempts: 3,
      maxDelaySeconds: 60,
    }),
  );

  // --- Middleware chain (order matters!) ---
  // 1. Allowlist check — FIRST, so unauthorized users can't reach any handler
  bot.use(allowlistMiddleware());

  // --- Command handlers ---
  registerStartHandler(bot);
  registerCommandHandlers(bot, options);

  // --- URL & Callback handlers ---
  registerUrlHandlers(bot);

  // --- Error handler ---
  bot.catch((err) => {
    logger.error({ error: err.message, stack: err.stack }, 'Bot error');
  });

  return bot;
}

module.exports = { createBot };
