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
