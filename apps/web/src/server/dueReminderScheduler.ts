import { processDueReminders } from "@kan/api/utils/dueReminders";
import { createDrizzleClient } from "@kan/db/client";
import { createLogger } from "@kan/logger";

const log = createLogger("due-reminder-scheduler");

const INTERVAL_MS = 60_000;

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
    INTERVAL_MS,
  );
  log.info("Due reminder scheduler started");
}
