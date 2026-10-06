export const cardCoverColours = [
  "#0d9488",
  "#65a30d",
  "#0284c7",
  "#4f46e5",
  "#ca8a04",
  "#ea580c",
  "#dc2626",
  "#db2777",
  "#475569",
] as const;

export type CardCoverColour = (typeof cardCoverColours)[number];

/** Minutes before the due date that a reminder can be sent. */
export const dueReminderOptions = [0, 5, 15, 60, 120, 1440, 2880] as const;

export type DueReminderOption = (typeof dueReminderOptions)[number];

/** Reminder offset selected when a due date is first added to a card. */
export const defaultDueReminderMinutes: DueReminderOption = 1440;

/**
 * A due date without a time counts as due at this hour of that day, so its
 * reminders go out during the working day instead of at midnight.
 */
export const dateOnlyReminderHour = 9;

/**
 * When a due date counts as reached for reminders. A date without a time is
 * stored as the start of its day in the time zone of whoever set it.
 */
export const getDueReminderBase = (dueDate: Date, hasTime: boolean) =>
  hasTime
    ? dueDate
    : new Date(dueDate.getTime() + dateOnlyReminderHour * 60 * 60 * 1000);
