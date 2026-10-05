import { processDueReminders } from "@kan/api/utils/dueReminders";
import { processIntegrationJobs } from "@kan/api/utils/integrationJobs";
import { createDrizzleClient } from "@kan/db/client";
import { createLogger } from "@kan/logger";

const log = createLogger("due-reminder-scheduler");

// Every minute by default. Hosts that bill for an always-awake database (e.g.
// Neon scale-to-zero) can poll less often via DUE_REMINDERS_INTERVAL_SECONDS
// (30 to 1800; reminders more than an hour late are skipped).
const intervalMs = () => {
  // eslint-disable-next-line no-restricted-properties, turbo/no-undeclared-env-vars
  const seconds = Number(process.env.DUE_REMINDERS_INTERVAL_SECONDS);
  return Number.isFinite(seconds) && seconds >= 30 && seconds <= 1800
    ? seconds * 1000
    : 60_000;
};

declare global {
  // Survives hot reloads in development so only one timer ever runs
  // eslint-disable-next-line no-var
  var __kanDueReminderTimer: ReturnType<typeof setInterval> | undefined;
}

/**
 * Runs background work inside the web server process: due date reminders
 * (unless disabled) and queued integration jobs such as Google Chat messages
 * and Calendar/Tasks syncs, on every tick. New integration jobs also run about
 * a second after they're queued. Several instances can run this safely: each
 * reminder and job is claimed atomically.
 */
export function startDueReminderScheduler({
  remindersEnabled = true,
}: { remindersEnabled?: boolean } = {}) {
  if (globalThis.__kanDueReminderTimer) return;

  const db = createDrizzleClient();
  let remindersRunning = false;
  let jobsRunning = false;
  let jobRunRequests = 0;

  const runJobs = async () => {
    jobRunRequests++;
    // A run already in progress picks up this request when it finishes
    if (jobsRunning) return;
    jobsRunning = true;
    try {
      let handled = 0;
      while (handled < jobRunRequests) {
        handled = jobRunRequests;
        await processIntegrationJobs(db);
      }
    } catch (error) {
      log.error({ err: error }, "Integration job run failed");
    } finally {
      jobsRunning = false;
    }
  };

  const tick = async () => {
    if (remindersEnabled && !remindersRunning) {
      remindersRunning = true;
      try {
        await processDueReminders(db);
      } catch (error) {
        log.error({ err: error }, "Due reminder check failed");
      } finally {
        remindersRunning = false;
      }
    }
    await runJobs();
  };

  let soonTimer: ReturnType<typeof setTimeout> | undefined;
  globalThis.__kanRunIntegrationJobsSoon = () => {
    if (soonTimer) return;
    soonTimer = setTimeout(() => {
      soonTimer = undefined;
      void runJobs();
    }, 1000);
  };

  globalThis.__kanDueReminderTimer = setInterval(
    () => void tick(),
    intervalMs(),
  );
  log.info(
    { intervalMs: intervalMs(), remindersEnabled },
    "Background scheduler started",
  );
}
