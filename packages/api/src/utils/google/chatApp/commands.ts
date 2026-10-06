import { dueReminderOptions } from "@kan/shared/constants";

/**
 * What someone asked the Kan Chat app to do, parsed from the text after the
 * mention (or the whole message in a direct message).
 */
export type ChatAppCommand =
  | { kind: "help" }
  | { kind: "add"; text: string }
  | { kind: "link"; board: string; list: string | null }
  | { kind: "unlink" }
  | { kind: "boards" }
  | { kind: "lists" }
  | { kind: "due" }
  | { kind: "reminders"; enabled: boolean | null }
  | { kind: "unknown"; text: string };

const ADD_WORDS = new Set(["add", "new", "create", "task", "card", "todo"]);

export const parseCommand = (input: string): ChatAppCommand => {
  const text = input
    .trim()
    .replace(/^\/kan\b/i, "")
    .trim();
  if (!text) return { kind: "help" };

  const match = /^(\S+)\s*([\s\S]*)$/.exec(text);
  const word = (match?.[1] ?? "").toLowerCase().replace(/[:,.!]+$/, "");
  const rest = (match?.[2] ?? "").trim();

  if (ADD_WORDS.has(word)) {
    return rest ? { kind: "add", text: rest } : { kind: "help" };
  }

  switch (word) {
    case "help":
    case "?":
    case "hi":
    case "hello":
      return { kind: "help" };
    case "link":
    case "use": {
      if (!rest) return { kind: "boards" };
      const [board, list] = rest.split(/\s+[/>›]\s+|\s*[/›]\s*/, 2);
      return {
        kind: "link",
        board: (board ?? "").trim(),
        list: list?.trim() ? list.trim() : null,
      };
    }
    case "unlink":
      return { kind: "unlink" };
    case "boards":
      return { kind: "boards" };
    case "lists":
      return { kind: "lists" };
    case "due":
    case "mine":
    case "my":
    case "agenda":
      return { kind: "due" };
    case "reminders":
    case "reminder": {
      const value = rest.toLowerCase();
      if (["on", "yes", "enable", "start"].includes(value))
        return { kind: "reminders", enabled: true };
      if (["off", "no", "disable", "stop"].includes(value))
        return { kind: "reminders", enabled: false };
      return { kind: "reminders", enabled: null };
    }
  }

  return { kind: "unknown", text };
};

// --- Dates -----------------------------------------------------------------

/** Minutes east of UTC for a time zone at a moment, e.g. 60 for Lagos. */
const zoneOffsetMinutes = (timeZone: string, at: Date) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
};

/** The calendar date it is right now in a time zone. */
export const zonedToday = (timeZone: string, now: Date) => {
  const shifted = new Date(
    now.getTime() + zoneOffsetMinutes(timeZone, now) * 60000,
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
};

/** The instant a wall-clock time in a time zone happens. */
export const zonedTimeToUtc = (
  parts: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
  },
  timeZone: string,
) => {
  const guess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
  );
  // Two passes settle the offset across daylight saving changes
  let instant = guess - zoneOffsetMinutes(timeZone, new Date(guess)) * 60000;
  instant = guess - zoneOffsetMinutes(timeZone, new Date(instant)) * 60000;
  return new Date(instant);
};

export const isValidTimeZone = (timeZone: string | null | undefined) => {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
};

const WEEKDAYS = [
  ["sun", "sunday"],
  ["mon", "monday"],
  ["tue", "tues", "tuesday"],
  ["wed", "wednesday"],
  ["thu", "thur", "thurs", "thursday"],
  ["fri", "friday"],
  ["sat", "saturday"],
];

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

/** When a date has no time, the card is due at this hour. */
export const DEFAULT_DUE_HOUR = 9;

interface DateParts {
  year: number;
  month: number;
  day: number;
}

const addDays = (date: DateParts, days: number): DateParts => {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
};

const isRealDate = ({ year, month, day }: DateParts) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

const parseTime = (raw: string): { hour: number; minute: number } | null => {
  const value = raw
    .trim()
    .toLowerCase()
    .replace(/^at\s+/, "");
  if (value === "noon") return { hour: 12, minute: 0 };
  if (value === "midnight") return { hour: 0, minute: 0 };
  const match = /^(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm)?$/.exec(value);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = match[3];
  // A bare number like "15" is only a time with am/pm or a colon
  if (!meridiem && match[2] === undefined) return null;
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "pm" && hour !== 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }
  return { hour, minute };
};

const parseDate = (raw: string, today: DateParts): DateParts | null => {
  const value = raw
    .trim()
    .toLowerCase()
    .replace(/^(on|next)\s+/, "");

  if (value === "today") return today;
  if (value === "tomorrow" || value === "tmr" || value === "tmrw")
    return addDays(today, 1);

  const weekday = WEEKDAYS.findIndex((names) => names.includes(value));
  if (weekday !== -1) {
    const todayWeekday = new Date(
      Date.UTC(today.year, today.month - 1, today.day),
    ).getUTCDay();
    return addDays(today, (weekday - todayWeekday + 7) % 7);
  }

  const inDays = /^in\s+(\d{1,3})\s+(day|days|week|weeks)$/.exec(value);
  if (inDays) {
    const amount = Number(inDays[1]);
    return addDays(today, inDays[2]?.startsWith("week") ? amount * 7 : amount);
  }

  // 2026-10-09
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (iso) {
    const date = {
      year: Number(iso[1]),
      month: Number(iso[2]),
      day: Number(iso[3]),
    };
    return isRealDate(date) ? date : null;
  }

  // 9/10 or 9/10/2026: day first
  const dayFirst = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?$/.exec(value);
  if (dayFirst) {
    const year = dayFirst[3]
      ? Number(dayFirst[3].length === 2 ? `20${dayFirst[3]}` : dayFirst[3])
      : today.year;
    const date = { year, month: Number(dayFirst[2]), day: Number(dayFirst[1]) };
    if (!isRealDate(date)) return null;
    // Without a year, a date that has passed means next year
    if (
      !dayFirst[3] &&
      Date.UTC(date.year, date.month - 1, date.day) <
        Date.UTC(today.year, today.month - 1, today.day)
    ) {
      date.year += 1;
    }
    return isRealDate(date) ? date : null;
  }

  // 9 oct, oct 9, 9 october 2026
  // Normalised to [day, month name, year]
  const dayMonth = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)(?:\s+(\d{4}))?$/.exec(
    value,
  );
  const monthDay =
    /^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/.exec(value);
  const named = dayMonth
    ? [dayMonth[1], dayMonth[2], dayMonth[3]]
    : monthDay
      ? [monthDay[2], monthDay[1], monthDay[3]]
      : null;
  if (named) {
    const month = MONTHS.findIndex((name) => (named[1] ?? "").startsWith(name));
    if (month === -1) return null;
    const date = {
      year: named[2] ? Number(named[2]) : today.year,
      month: month + 1,
      day: Number(named[0]),
    };
    if (!isRealDate(date)) return null;
    if (
      !named[2] &&
      Date.UTC(date.year, date.month - 1, date.day) <
        Date.UTC(today.year, today.month - 1, today.day)
    ) {
      date.year += 1;
    }
    return date;
  }

  return null;
};

/**
 * Parses "tomorrow", "fri 3pm", "9/10 14:30", "2026-10-09 at 09:00" and the
 * like, in the given time zone. A date without a time is due at 9am.
 */
export const parseDue = (
  raw: string,
  timeZone: string,
  now: Date,
): { date: Date; hasTime: boolean } | null => {
  const value = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!value) return null;
  const today = zonedToday(timeZone, now);

  // A time on its own means today
  const timeOnly = parseTime(value);
  if (timeOnly) {
    return {
      date: zonedTimeToUtc({ ...today, ...timeOnly }, timeZone),
      hasTime: true,
    };
  }

  // Try every split point: the longest date followed by a time
  const words = value.split(" ");
  for (let split = words.length; split >= 1; split--) {
    const date = parseDate(words.slice(0, split).join(" "), today);
    if (!date) continue;
    const timeText = words.slice(split).join(" ");
    if (!timeText) {
      return {
        date: zonedTimeToUtc(
          { ...date, hour: DEFAULT_DUE_HOUR, minute: 0 },
          timeZone,
        ),
        hasTime: false,
      };
    }
    const time = parseTime(timeText);
    if (time) {
      return {
        date: zonedTimeToUtc({ ...date, ...time }, timeZone),
        hasTime: true,
      };
    }
  }

  return null;
};

/** "15m", "1h", "2 hours", "1d", "0" or "at due" → minutes before due. */
export const parseReminder = (raw: string): number | null => {
  const value = raw.trim().toLowerCase();
  if (["0", "at due", "on time", "when due", "at due time"].includes(value))
    return 0;
  const match =
    /^(\d{1,4})\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)(?:\s+before)?$/.exec(
      value,
    );
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] ?? "m";
  const minutes = unit.startsWith("d")
    ? amount * 1440
    : unit.startsWith("h")
      ? amount * 60
      : amount;
  return (dueReminderOptions as readonly number[]).includes(minutes)
    ? minutes
    : null;
};

export interface ParsedNewCard {
  title: string;
  dueDate: Date | null;
  dueHasTime: boolean;
  reminderMinutes: number | null;
  error?: string;
}

/**
 * Splits "Fix the login bug due fri 3pm remind 1h" into a title, a due date
 * and a reminder. With a due date but no "remind", a card with a time is
 * reminded 15 minutes before and a card with only a date at its due time.
 */
export const parseNewCard = (
  text: string,
  timeZone: string,
  now: Date,
): ParsedNewCard => {
  let rest = text.trim();
  let reminderMinutes: number | null = null;
  let reminderGiven = false;
  let noReminder = false;

  const remindMatch = /\s+(?:remind(?:er)?(?:\s+me)?)\s+(.+?)\s*$/i.exec(rest);
  if (remindMatch) {
    const minutes = parseReminder(remindMatch[1] ?? "");
    if (minutes === null) {
      return {
        title: rest,
        dueDate: null,
        dueHasTime: false,
        reminderMinutes: null,
        error: `I can remind at due time (0), or 5m, 15m, 1h, 2h, 1d or 2d before. "${remindMatch[1]}" isn't one of those.`,
      };
    }
    reminderMinutes = minutes;
    reminderGiven = true;
    rest = rest.slice(0, remindMatch.index).trim();
  } else if (/\s+no\s+reminder\s*$/i.test(rest)) {
    noReminder = true;
    rest = rest.replace(/\s+no\s+reminder\s*$/i, "").trim();
  }

  let dueDate: Date | null = null;
  let dueHasTime = false;
  const dueMatch = /\s+(?:due|by)\s+(.+?)\s*$/i.exec(rest);
  if (dueMatch) {
    const due = parseDue(dueMatch[1] ?? "", timeZone, now);
    if (!due) {
      return {
        title: rest,
        dueDate: null,
        dueHasTime: false,
        reminderMinutes: null,
        error: `I couldn't read the due date "${dueMatch[1]}". Try "due tomorrow 3pm", "due fri", "due 9/10 14:30" or "due 2026-10-09".`,
      };
    }
    dueDate = due.date;
    dueHasTime = due.hasTime;
    rest = rest.slice(0, dueMatch.index).trim();
  }

  const title = rest.replace(/\s+/g, " ").trim();
  if (!title) {
    return {
      title,
      dueDate,
      dueHasTime,
      reminderMinutes,
      error: "The task needs a title, like: add Fix the login bug due fri 3pm",
    };
  }

  if (dueDate && !reminderGiven && !noReminder) {
    reminderMinutes = dueHasTime ? 15 : 0;
  }
  if (!dueDate) reminderMinutes = null;

  return { title: title.slice(0, 2000), dueDate, dueHasTime, reminderMinutes };
};
