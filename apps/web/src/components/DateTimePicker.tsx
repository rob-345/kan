import { t } from "@lingui/core/macro";
import { format, startOfDay } from "date-fns";

import DateSelector from "~/components/DateSelector";

export interface DateTimeValue {
  date: Date | null;
  /** false means the date is a whole day, kept as the start of that day */
  hasTime: boolean;
}

const DEFAULT_TIME = "09:00";

const withTime = (day: Date, time: string) => {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  const date = startOfDay(day);
  date.setHours(hours, minutes, 0, 0);
  return date;
};

/**
 * A calendar with an optional time of day. Changes are reported as they're
 * made; the caller decides when to save them.
 */
export default function DateTimePicker({
  value,
  onChange,
  weekStartsOn,
}: {
  value: DateTimeValue;
  onChange: (value: DateTimeValue) => void;
  weekStartsOn?: 0 | 1 | 6;
}) {
  const time = value.date && value.hasTime ? format(value.date, "HH:mm") : "";

  return (
    <div>
      <DateSelector
        selectedDate={value.date ?? undefined}
        onDateSelect={(day) =>
          onChange(
            day
              ? {
                  date: value.hasTime
                    ? withTime(day, time || DEFAULT_TIME)
                    : startOfDay(day),
                  hasTime: value.hasTime,
                }
              : { date: null, hasTime: false },
          )
        }
        weekStartsOn={weekStartsOn}
      />
      <div className="flex items-center gap-2 border-t border-light-200 px-4 py-3 text-xs text-light-900 dark:border-dark-200 dark:text-dark-900">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={value.hasTime}
            disabled={!value.date}
            onChange={(e) => {
              if (!value.date) return;
              onChange(
                e.target.checked
                  ? { date: withTime(value.date, DEFAULT_TIME), hasTime: true }
                  : { date: startOfDay(value.date), hasTime: false },
              );
            }}
            className="h-4 w-4 rounded border-light-500 text-blue-600 focus:ring-0 disabled:opacity-50 dark:border-dark-500 dark:bg-dark-100"
          />
          {t`Time`}
        </label>
        {value.hasTime && value.date && (
          <input
            type="time"
            aria-label={t`Time`}
            value={time}
            onChange={(e) => {
              if (!value.date || !e.target.value) return;
              onChange({
                date: withTime(value.date, e.target.value),
                hasTime: true,
              });
            }}
            className="rounded-[5px] border-light-300 bg-light-50 px-2 py-1 text-xs dark:border-dark-300 dark:bg-dark-100 dark:text-dark-1000"
          />
        )}
      </div>
    </div>
  );
}
