import { processDueReminders } from "@kan/api/utils/dueReminders";
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
 * Checks for due date reminders once a minute inside the web server process.
 * Several instances can run this safely: each reminder is claimed atomically.
 */
export function startDueReminderScheduler() {
  if (globalThis.__kanDueReminderTimer) return;

  const db = createDrizzleClient();
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await processDueReminders(db);
    } catch (error) {
      log.error({ err: error }, "Due reminder check failed");
    } finally {
      running = false;
    }
  };

  globalThis.__kanDueReminderTimer = setInterval(
    () => void tick(),
    intervalMs(),
  );
  log.info({ intervalMs: intervalMs() }, "Due reminder scheduler started");
}
