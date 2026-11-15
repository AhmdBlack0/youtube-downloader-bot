// @ts-check

/*
 * TESTS FOR: src/bot/middleware/allowlist.js
 *
 * STRATEGY:
 * We don't need a real Telegram connection to test middleware.
 * grammY middleware is just a function that takes (ctx, next).
 * We create fake ctx objects with the fields we need, and a mock next().
 *
 * WHY MOCK ctx AND NOT THE WHOLE BOT?
 * Because middleware is a pure function of (ctx, next). Testing it in isolation
 * is faster, simpler, and proves the logic independently of grammY internals.
 */

// Set up env BEFORE requiring the config module
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_URL = 'postgresql://x:x@localhost/x';
process.env.ALLOWED_USER_IDS = '111,222';
process.env.NODE_ENV = 'test';

const { allowlistMiddleware } = require('../../src/bot/middleware/allowlist');

describe('Allowlist middleware', () => {
  const middleware = allowlistMiddleware();

  function makeCtx(userId) {
    return {
      from: userId !== null ? { id: userId } : undefined,
      reply: jest.fn(),
    };
  }

  test('allowed user → next() is called', async () => {
    const ctx = makeCtx(111); // In ALLOWED_USER_IDS
    const next = jest.fn();

    await middleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  test('another allowed user → next() is called', async () => {
    const ctx = makeCtx(222);
    const next = jest.fn();

    await middleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('unknown user → blocked with Arabic message, next() NOT called', async () => {
    const ctx = makeCtx(999); // Not in ALLOWED_USER_IDS
    const next = jest.fn();

    await middleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(ctx.reply.mock.calls[0][0]).toContain('عذراً');
  });

  test('no from field (channel post) → silently ignored, next() NOT called', async () => {
    const ctx = makeCtx(null);
    ctx.from = undefined;
    const next = jest.fn();

    await middleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});
