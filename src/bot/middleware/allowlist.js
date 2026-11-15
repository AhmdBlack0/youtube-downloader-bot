// @ts-check

/*
 * ALLOWLIST MIDDLEWARE
 * -------------------
 * grammY middleware is a chain of functions. Each function receives the context
 * (ctx) and a "next" function. If you call next(), the request moves to the
 * next middleware. If you DON'T call next(), the chain stops — the message is
 * effectively blocked.
 *
 * Think of it like a bouncer at a club. The bouncer checks your ID against the
 * guest list. If you're on the list, you pass through. If not, you get a polite
 * "sorry" and the door stays shut.
 *
 * WHY MIDDLEWARE AND NOT AN if() IN EVERY HANDLER?
 * DRY principle. With middleware, the check happens ONCE, before any handler.
 * If we checked in every handler, we'd eventually forget one and leak access.
 */

const { config, logger } = require('../../config');

/**
 * Middleware that only lets through users whose Telegram ID is in ALLOWED_USER_IDS.
 * Unknown users get a polite Arabic refusal.
 */
function allowlistMiddleware() {
  // If running in public mode, pass through all users without blocking
  if (config.isPublic || !config.allowedUserIds) {
    logger.info('🌍 Bot is running in PUBLIC mode (access open to all users)');
    return async (ctx, next) => {
      if (!ctx.from?.id) return;
      await next();
    };
  }

  const allowedSet = new Set(config.allowedUserIds);

  return async (ctx, next) => {
    const userId = ctx.from?.id;

    if (!userId) {
      // No user info (channel posts, etc.) — silently ignore
      return;
    }

    // ctx.from.id is a JS number. Our allowlist is BigInt.
    // We convert to BigInt for comparison.
    // WHY NOT store as Number? Because IDs > 2^53-1 would silently corrupt.
    // Better to always use BigInt and pay the conversion cost once per message.
    const userIdBigInt = BigInt(userId);

    if (!allowedSet.has(userIdBigInt)) {
      logger.info({ userId: userId.toString() }, 'Unauthorized access attempt');
      await ctx.reply(
        '⛔ عذراً، هذا البوت خاص ولا يمكنك استخدامه.\n(Sorry, this is a private bot.)',
      );
      return; // Do NOT call next() — block the chain
    }

    // User is allowed — continue to the next middleware/handler
    await next();
  };
}

module.exports = { allowlistMiddleware };
