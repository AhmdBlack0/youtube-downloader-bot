// @ts-check

/*
 * PRISMA CLIENT — SINGLETON PATTERN
 * ----------------------------------
 * Why not just `new PrismaClient()` everywhere? Because each instance opens
 * its own connection pool to Postgres. If you create one per request or per
 * module import, you'll exhaust connections fast.
 *
 * The singleton pattern: create one instance, export it, reuse everywhere.
 * In tests, we can still create a separate instance pointed at a test DB.
 */

const { PrismaClient } = require('@prisma/client');
const { logger } = require('../config/logger');

/**
 * Configure database URL with optimal pool settings for remote cloud Neon PostgreSQL.
 * Sets connection_limit to 25 and pool_timeout to 30s to prevent pool exhaustion over WAN.
 * @returns {string}
 */
function getOptimizedDatabaseUrl() {
  const rawUrl = process.env.DATABASE_URL || '';
  if (!rawUrl) return rawUrl;

  try {
    const url = new URL(rawUrl);
    // Strip channel_binding as it causes TLS negotiation issues with Prisma & Neon connection poolers
    if (url.searchParams.has('channel_binding')) {
      url.searchParams.delete('channel_binding');
    }
    if (!url.searchParams.has('sslmode')) {
      url.searchParams.set('sslmode', 'require');
    }
    if (!url.searchParams.has('connection_limit')) {
      url.searchParams.set('connection_limit', '25');
    }
    if (!url.searchParams.has('pool_timeout')) {
      url.searchParams.set('pool_timeout', '30');
    }
    return url.toString();
  } catch (_err) {
    return rawUrl;
  }
}

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: getOptimizedDatabaseUrl(),
    },
  },
  log: [
    { emit: 'event', level: 'error' },
    { emit: 'event', level: 'warn' },
  ],
});

// Pipe Prisma's logs into pino so everything goes through one logger
prisma.$on('error', (e) => {
  logger.error({ prismaError: e }, 'Prisma error');
});

prisma.$on('warn', (e) => {
  logger.warn({ prismaWarning: e }, 'Prisma warning');
});

/**
 * Apply raw SQL migrations that Prisma schema DSL cannot express.
 * Specifically: partial unique index enforcing at most 1 active job per user at DB level.
 *
 * @param {PrismaClient} [prismaClient]
 */
async function applyCustomIndexes(prismaClient = prisma) {
  await prismaClient.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "unique_active_job_per_user"
    ON "Job" ("userId")
    WHERE status IN ('QUEUED', 'RUNNING');
  `);

  await prismaClient.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "MediaCache" (
      "id" SERIAL PRIMARY KEY,
      "youtubeId" TEXT NOT NULL,
      "quality" TEXT NOT NULL,
      "fileId" TEXT NOT NULL,
      "fileUniqueId" TEXT,
      "title" TEXT,
      "performer" TEXT,
      "duration" INTEGER,
      "fileSizeBytes" BIGINT,
      "mimeType" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await prismaClient.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "MediaCache_youtubeId_quality_key"
    ON "MediaCache" ("youtubeId", "quality");
  `);
}

module.exports = { prisma, applyCustomIndexes };
