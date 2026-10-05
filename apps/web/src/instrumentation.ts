/* eslint-disable no-restricted-properties, turbo/no-undeclared-env-vars -- runs before env validation, server only */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.DUE_REMINDERS_DISABLED?.toLowerCase() === "true") return;
  // The embedded PGLite fallback can't be shared with a second connection
  if (!process.env.POSTGRES_URL) return;

  const { startDueReminderScheduler } = await import(
    "./server/dueReminderScheduler"
  );
  startDueReminderScheduler();
}
