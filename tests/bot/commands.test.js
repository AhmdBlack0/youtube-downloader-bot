// @ts-check

const { prisma, applyCustomIndexes } = require('../../src/modules/db');
const { registerCommandHandlers } = require('../../src/bot/handlers/commands');
const { createJob } = require('../../src/modules/jobs/jobService');

describe('Bot Commands (/status and /cancel)', () => {
  let testUser;

  beforeAll(async () => {
    await prisma.$connect();
    await applyCustomIndexes(prisma);

    testUser = await prisma.user.upsert({
      where: { telegramId: BigInt(888123) },
      create: { telegramId: BigInt(888123), username: 'command_tester' },
      update: {},
    });
  }, 20000);

  afterAll(async () => {
    if (testUser) {
      await prisma.pendingChoice.deleteMany({ where: { userId: testUser.id } }).catch(() => {});
      await prisma.jobItem.deleteMany({ where: { job: { userId: testUser.id } } }).catch(() => {});
      await prisma.job.deleteMany({ where: { userId: testUser.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: testUser.id } }).catch(() => {});
    }
    await prisma.$disconnect();
  }, 20000);

  beforeEach(async () => {
    await prisma.jobItem.deleteMany({ where: { job: { userId: testUser.id } } });
    await prisma.job.deleteMany({ where: { userId: testUser.id } });
  });

  test('/status when no active job exists -> replies with no-active-job message', async () => {
    // Execute command handler directly with mock ctx
    let replyMsg = '';
    const ctx = {
      from: { id: Number(testUser.telegramId) },
      reply: async (text) => {
        replyMsg = text;
      },
    };

    // Call the handler directly from registerCommandHandlers logic
    const { registerCommandHandlers } = require('../../src/bot/handlers/commands');
    const mockBot = {
      command: (name, fn) => {
        if (name === 'status') mockBot.statusFn = fn;
        if (name === 'cancel') mockBot.cancelFn = fn;
      },
    };
    registerCommandHandlers(mockBot);

    await mockBot.statusFn(ctx);
    expect(replyMsg).toContain('لا يوجد لديك أي طلب نشط حالياً');
  });

  test('/status when active job exists -> returns status details and cancel button', async () => {
    const job = await createJob({
      userId: testUser.id,
      url: 'https://www.youtube.com/watch?v=status12345',
      kind: 'VIDEO',
      quality: '720',
    });

    let replyMsg = '';
    let replyExtra = null;
    const ctx = {
      from: { id: Number(testUser.telegramId) },
      reply: async (text, extra) => {
        replyMsg = text;
        replyExtra = extra;
      },
    };

    const mockBot = {
      command: (name, fn) => {
        if (name === 'status') mockBot.statusFn = fn;
      },
    };
    registerCommandHandlers(mockBot);

    await mockBot.statusFn(ctx);

    expect(replyMsg).toContain(`حالة طلبك الحالي #${job.id}`);
    expect(replyMsg).toContain('720p');
    expect(replyExtra?.reply_markup).toBeDefined();
  });

  test('/cancel when no active job exists -> replies with no-active-job message', async () => {
    let replyMsg = '';
    const ctx = {
      from: { id: Number(testUser.telegramId) },
      reply: async (text) => {
        replyMsg = text;
      },
    };

    const mockBot = {
      command: (name, fn) => {
        if (name === 'cancel') mockBot.cancelFn = fn;
      },
    };
    registerCommandHandlers(mockBot);

    await mockBot.cancelFn(ctx);
    expect(replyMsg).toContain('لا يوجد لديك أي طلب نشط لإلغائه');
  });

  test('/cancel with active job -> cancels job in DB and reports success', async () => {
    const job = await createJob({
      userId: testUser.id,
      url: 'https://www.youtube.com/watch?v=cancel12345',
      kind: 'VIDEO',
      quality: '1080',
    });

    let replyMsg = '';
    const ctx = {
      from: { id: Number(testUser.telegramId) },
      reply: async (text) => {
        replyMsg = text;
      },
    };

    const mockWorker = {
      cancel: jest.fn(),
    };

    const mockBot = {
      command: (name, fn) => {
        if (name === 'cancel') mockBot.cancelFn = fn;
      },
    };
    registerCommandHandlers(mockBot, { worker: mockWorker });

    await mockBot.cancelFn(ctx);

    expect(replyMsg).toContain(`تم إلغاء طلبك #${job.id} بنجاح`);
    expect(mockWorker.cancel).toHaveBeenCalledWith(job.id);

    // Verify DB status
    const inDb = await prisma.job.findUnique({ where: { id: job.id } });
    expect(inDb?.status).toBe('CANCELLED');
  });
});
