/* eslint-disable no-restricted-properties, turbo/no-undeclared-env-vars -- runs before env validation, server only */
export async function register() {
  // Keep the import inside this exact check so the bundler drops it from the
  // edge build (nodemailer and pg need Node built-ins)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // The embedded PGLite fallback can't be shared with a second connection
    if (!process.env.POSTGRES_URL) return;

    const remindersEnabled =
      process.env.DUE_REMINDERS_DISABLED?.toLowerCase() !== "true";

    const { startDueReminderScheduler } = await import(
      "./server/dueReminderScheduler"
    );
    startDueReminderScheduler({ remindersEnabled });
  }
}
