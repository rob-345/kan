import type { Locale } from "date-fns";
import { t } from "@lingui/core/macro";
import { format, isBefore, isSameYear, startOfDay } from "date-fns";

/**
 * Formats a card or checklist item date, adding the time only when one was
 * set. A date without a time is stored as the start of its day.
 */
export const formatDueDate = (
  date: Date,
  hasTime: boolean,
  options: { locale?: Locale; short?: boolean } = {},
) => {
  const datePattern = options.short
    ? isSameYear(date, new Date())
      ? "MMM d"
      : "MMM d, yyyy"
    : "MMM d, yyyy";
  return format(date, hasTime ? `${datePattern}, p` : datePattern, {
    locale: options.locale,
  });
};

/** True once a date has passed: its time, or the whole day without one. */
export const isPastDue = (date: Date, hasTime: boolean, now = new Date()) =>
  hasTime ? isBefore(date, now) : isBefore(date, startOfDay(now));

/** The label for a "minutes before the due date" reminder option. */
export const reminderLabel = (minutes: number, hasTime = true) => {
  if (minutes === 0) return hasTime ? t`At time of due date` : t`On the day`;
  if (minutes < 60) return t`${minutes} minutes before`;
  if (minutes < 1440) {
    const hours = minutes / 60;
    return hours === 1 ? t`1 hour before` : t`${hours} hours before`;
  }
  const days = minutes / 1440;
  return days === 1 ? t`1 day before` : t`${days} days before`;
};
