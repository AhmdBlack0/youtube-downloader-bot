# ADR 0001: PostgreSQL for Job Queue and Concurrency Guarantees

* **Status:** Accepted
* **Date:** 2026-11-14
* **Deciders:** Mentorship Engineering Team
* **Context:** YouTube Downloader Telegram Bot

---

## 1. Context and Problem Statement

A Telegram bot that downloads long-running media (videos and 25-item playlists) needs a reliable background processing engine. Individual jobs can take anywhere from 10 seconds to 30 minutes, during which:
1. The server or container may crash or restart (SIGTERM / SIGKILL).
2. Users might double-click buttons or send multiple URLs concurrently, causing race conditions.
3. Media downloads consume heavy bandwidth, disk space, and CPU.

We must decide **where** and **how** to store and coordinate jobs, and how to guarantee that a user has **at most one active job** at any given time.

---

## 2. Decision Drivers

- **Crash Resilience:** If the Node process restarts, active and queued jobs must not evaporate into the ether.
- **Strict Concurrency Guarantees:** Preventing user spam (accidental or intentional concurrent downloads) must be rock-solid, race-free, and impossible to bypass.
- **Operational Simplicity:** Avoid unnecessary operational overhead (e.g. running multiple databases, cache clusters, or broker Daemons) for a personal/small-scale service.
- **Atomic Work Distribution:** Multiple worker loops must be able to claim items without double-processing.

---

## 3. Considered Options

### Option A: In-Memory Queue (Node.js Array / Map / EventEmitter)
* **How it works:** Jobs live in JavaScript variables (`const queue = []`).
* **Why Rejected:**
  - Zero persistence. A container restart or unhandled exception destroys all user jobs.
  - Progress and state cannot be queried across process restarts.
  - Concurrency control is limited to a single Node thread; cannot scale to multi-process workers.

### Option B: Redis + BullMQ
* **How it works:** Redis acts as the message broker, BullMQ manages queues and retries.
* **Why Rejected:**
  - Adds a third infrastructure dependency alongside PostgreSQL and the Telegram Bot API server.
  - Enforcing strict multi-field state constraints (e.g. "at most one job in states `QUEUED` or `RUNNING` per user across the entire cluster") requires distributed locks or custom Lua scripts.
  - Data is split across two data stores: relational entities in Postgres, transient job states in Redis.

### Option C: PostgreSQL (`FOR UPDATE SKIP LOCKED` + Partial Unique Index) (Chosen)
* **How it works:**
  - Jobs and JobItems are relational tables in PostgreSQL.
  - Workers atomically claim the next available job using SQL:
    ```sql
    WITH next_job AS (
      SELECT id FROM "Job"
      WHERE status = 'QUEUED'
      ORDER BY "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "Job"
    SET status = 'RUNNING', "updatedAt" = NOW()
    WHERE id = (SELECT id FROM next_job)
    RETURNING *;
    ```
  - Concurrency is strictly bounded at the storage layer via a PostgreSQL partial unique index:
    ```sql
    CREATE UNIQUE INDEX "unique_active_job_per_user"
    ON "Job" ("userId")
    WHERE status IN ('QUEUED', 'RUNNING');
    ```

---

## 4. Decision Outcome

We selected **Option C: PostgreSQL with `FOR UPDATE SKIP LOCKED` and Partial Unique Index**.

### Rationale:
1. **Zero Additional Infrastructure:** PostgreSQL 16 is already required for users and audit records. Using Postgres as the queue eliminates the need for Redis, reducing operational maintenance, memory footprint, and points of failure.
2. **The "Ticket Rail" Analogy (`FOR UPDATE SKIP LOCKED`):**
   In a busy diner kitchen, order tickets are hung on a metal rail. When a cook is ready to prepare a meal, they slide their ticket off the rail. Other cooks scanning the rail simply skip the ticket that is already in another cook's hand. In Postgres, `FOR UPDATE SKIP LOCKED` does exactly this: multiple concurrent workers inspect the `QUEUED` rows, lock the first unlocked row, and skip all currently locked rows without waiting or blocking each other.
3. **Database-Enforced Active Job Constraint:**
   Application-level checks ("check if active job exists $\rightarrow$ insert job") have an inherent Time-of-Check to Time-of-Use (**TOCTOU**) vulnerability. If a user fires 20 simultaneous HTTP callbacks, all 20 threads can pass the "check" before any thread reaches the "insert", creating 20 parallel downloads.
   By pushing this invariant down to the database engine via a **partial unique index**:
   - The PostgreSQL storage engine serializes the index check at disk/WAL level.
   - Exactly one `INSERT` succeeds.
   - The other 19 attempts immediately fail with Prisma error code `P2002` (unique constraint violation).
   - Our bot catches `P2002`, converts it into `ActiveJobExistsError`, and cleanly presents the user with an Arabic explanation and a Cancel button.

---

## 5. Trade-offs and Consequences

### Advantages:
- **ACID Integrity:** Job creation, quota deduction, and item insertion can run in a single atomic database transaction.
- **Crash Recovery:** If a worker dies mid-job, its heartbeat (`updatedAt`) goes stale. On startup, the surviving worker queries jobs stuck in `RUNNING` for over 60 seconds and recovers them without data loss.
- **Relational Reporting:** Playlist items are relational children of the job; progress can be queried with standard SQL joins.

### Disadvantages / Mitigation:
- **Throughput Limit:** Postgres queue tables experience high MVCC churn (frequent row updates/deletes). For workloads exceeding $10,000$ jobs/second, a dedicated memory broker like RabbitMQ or Kafka would be required. However, for a personal and team bot processing $1-100$ concurrent media downloads, PostgreSQL operates comfortably within sub-millisecond query response times.
