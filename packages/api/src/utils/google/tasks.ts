import type { CardSyncData } from "./calendar";
import { GoogleApiError, googleFetch } from "./oauth";

const TASKS_API = "https://tasks.googleapis.com/tasks/v1";

export const createKanTaskList = async (accessToken: string) => {
  const list = await googleFetch<{ id: string }>(
    accessToken,
    `${TASKS_API}/users/@me/lists`,
    { method: "POST", body: { title: "Kan" } },
  );
  if (!list) throw new Error("Google returned no task list");
  return list.id;
};

/**
 * The calendar date of an instant in a time zone, as Google Tasks wants it.
 * Tasks only store the date of a due time, never the time itself.
 */
export const toTaskDueDate = (date: Date, timeZone: string) => {
  let day: string;
  try {
    // en-CA formats as YYYY-MM-DD
    day = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    day = date.toISOString().slice(0, 10);
  }
  return `${day}T00:00:00.000Z`;
};

export const buildTask = (card: CardSyncData, timeZone: string) => ({
  title: card.title,
  notes: `${card.boardName} · ${card.listName}\n${card.cardUrl}`,
  due: toTaskDueDate(card.dueDate, timeZone),
  status: card.dueDateCompleted ? "completed" : "needsAction",
  // Clearing "completed" is required to reopen a task
  ...(!card.dueDateCompleted && { completed: null }),
});

const tasksUrl = (taskListId: string) =>
  `${TASKS_API}/lists/${encodeURIComponent(taskListId)}/tasks`;

const isGone = (error: unknown) =>
  error instanceof GoogleApiError &&
  (error.status === 404 || error.status === 410);

export const upsertTask = async (
  accessToken: string,
  taskListId: string,
  taskId: string | null,
  card: CardSyncData,
  timeZone: string,
) => {
  const body = buildTask(card, timeZone);

  if (taskId) {
    try {
      await googleFetch(
        accessToken,
        `${tasksUrl(taskListId)}/${encodeURIComponent(taskId)}`,
        { method: "PATCH", body },
      );
      return taskId;
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }

  const task = await googleFetch<{ id: string }>(
    accessToken,
    tasksUrl(taskListId),
    { method: "POST", body },
  );
  if (!task) throw new Error("Google returned no task");
  return task.id;
};

export const deleteTask = async (
  accessToken: string,
  taskListId: string,
  taskId: string,
) => {
  try {
    await googleFetch(
      accessToken,
      `${tasksUrl(taskListId)}/${encodeURIComponent(taskId)}`,
      { method: "DELETE" },
    );
  } catch (error) {
    if (!isGone(error)) throw error;
  }
};

/** Deletes the whole Kan task list, and with it every task Kan created. */
export const deleteKanTaskList = async (
  accessToken: string,
  taskListId: string,
) => {
  try {
    await googleFetch(
      accessToken,
      `${TASKS_API}/users/@me/lists/${encodeURIComponent(taskListId)}`,
      { method: "DELETE" },
    );
  } catch (error) {
    if (!isGone(error)) throw error;
  }
};
