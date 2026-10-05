import { and, eq, inArray, lt, sql } from "drizzle-orm";

import type { dbClient } from "@kan/db/client";
import type { IntegrationJobKind } from "@kan/db/schema";
import { integrationJobs } from "@kan/db/schema";

// Timestamps are stored as UTC without a time zone, matching Drizzle
const utc = (date: Date) =>
  sql`(${date.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

export interface NewIntegrationJob {
  kind: IntegrationJobKind;
  payload: Record<string, unknown>;
  /** Pending jobs with the same key are merged into one. */
  dedupeKey?: string;
  runAt?: Date;
}

export const enqueue = async (db: dbClient, jobs: NewIntegrationJob[]) => {
  if (jobs.length === 0) return;

  await db
    .insert(integrationJobs)
    .values(
      jobs.map((job) => ({
        kind: job.kind,
        payload: job.payload,
        dedupeKey: job.dedupeKey ?? null,
        runAt: job.runAt ?? new Date(),
      })),
    )
    .onConflictDoNothing();
};

/**
 * Claims jobs that are ready to run, so concurrent workers never run the same
 * job twice. Jobs left running for over ten minutes (a crashed worker) are
 * claimed again.
 */
export const claim = async (
  db: dbClient,
  args: { now: Date; limit?: number },
) => {
  const now = utc(args.now);

  const claimed = await db.execute<{ id: number }>(sql`
    UPDATE "integration_job"
    SET "status" = 'running', "lockedAt" = ${now}, "attempts" = "attempts" + 1
    WHERE id IN (
      SELECT id FROM "integration_job"
      WHERE ("status" = 'pending' AND "runAt" <= ${now})
         OR ("status" = 'running' AND "lockedAt" < ${now} - interval '10 minutes')
      ORDER BY "runAt", id
      LIMIT ${args.limit ?? 25}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `);

  const ids = claimed.rows.map((row) => Number(row.id));
  if (ids.length === 0) return [];

  return db.query.integrationJobs.findMany({
    where: inArray(integrationJobs.id, ids),
    orderBy: (jobs, { asc }) => [asc(jobs.runAt), asc(jobs.id)],
  });
};

export const complete = async (db: dbClient, jobId: number) => {
  await db.delete(integrationJobs).where(eq(integrationJobs.id, jobId));
};

/**
 * Puts a job back in the queue to try again later. If a newer pending job with
 * the same dedupe key already exists, that one does the work and this one is
 * dropped.
 */
export const retry = async (
  db: dbClient,
  job: { id: number; dedupeKey: string | null },
  args: { runAt: Date; error: string },
) => {
  if (job.dedupeKey) {
    const pending = await db.query.integrationJobs.findFirst({
      columns: { id: true },
      where: and(
        eq(integrationJobs.dedupeKey, job.dedupeKey),
        eq(integrationJobs.status, "pending"),
      ),
    });
    if (pending) {
      await complete(db, job.id);
      return;
    }
  }

  await db
    .update(integrationJobs)
    .set({
      status: "pending",
      runAt: args.runAt,
      lockedAt: null,
      lastError: args.error,
    })
    .where(eq(integrationJobs.id, job.id));
};

export const fail = async (db: dbClient, jobId: number, error: string) => {
  await db
    .update(integrationJobs)
    .set({ status: "failed", lockedAt: null, lastError: error })
    .where(eq(integrationJobs.id, jobId));
};

/** Removes failed jobs older than the given date. */
export const purgeFailed = async (db: dbClient, olderThan: Date) => {
  await db
    .delete(integrationJobs)
    .where(
      and(
        eq(integrationJobs.status, "failed"),
        lt(integrationJobs.createdAt, olderThan),
      ),
    );
};
