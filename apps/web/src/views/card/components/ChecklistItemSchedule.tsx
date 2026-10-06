import { t } from "@lingui/core/macro";
import { useState } from "react";
import { HiOutlineBell, HiOutlineCalendar, HiXMark } from "react-icons/hi2";
import { twMerge } from "tailwind-merge";

import {
  defaultDueReminderMinutes,
  dueReminderOptions,
} from "@kan/shared/constants";

import type { DateTimeValue } from "~/components/DateTimePicker";
import Avatar from "~/components/Avatar";
import DateTimePicker from "~/components/DateTimePicker";
import { usePopup } from "~/providers/popup";
import { useWorkspace } from "~/providers/workspace";
import { api } from "~/utils/api";
import { invalidateCard } from "~/utils/cardInvalidation";
import { formatDueDate, isPastDue, reminderLabel } from "~/utils/dueDates";

/** The sub-task fields of a checklist item, as returned by card.byId. */
export interface ChecklistItemScheduleData {
  publicId: string;
  completed: boolean;
  startDate: Date | null;
  startDateHasTime: boolean;
  dueDate: Date | null;
  dueDateHasTime: boolean;
  dueReminderMinutes: number | null;
  members: { publicId: string }[];
}

/** A board member who can be assigned to a checklist item. */
export interface AssignableMember {
  publicId: string;
  name: string;
  email: string;
  imageUrl?: string;
}

const sameValue = (a: DateTimeValue, date: Date | null, hasTime: boolean) =>
  (a.date?.getTime() ?? null) === (date?.getTime() ?? null) &&
  (!a.date || a.hasTime === hasTime);

/**
 * The dates, reminder and assignees of a checklist item, shown under its
 * title. Renders nothing when the item has none.
 */
export function ChecklistItemMeta({
  item,
  members,
}: {
  item: ChecklistItemScheduleData;
  members: AssignableMember[];
}) {
  const assignees = members.filter((member) =>
    item.members.some((assigned) => assigned.publicId === member.publicId),
  );
  if (!item.startDate && !item.dueDate && assignees.length === 0) return null;

  const overdue =
    !!item.dueDate &&
    !item.completed &&
    isPastDue(item.dueDate, item.dueDateHasTime);

  const dates = [
    item.startDate &&
      formatDueDate(item.startDate, item.startDateHasTime, { short: true }),
    item.dueDate &&
      formatDueDate(item.dueDate, item.dueDateHasTime, { short: true }),
  ].filter(Boolean);

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
      {dates.length > 0 && (
        <span
          className={twMerge(
            "inline-flex items-center gap-1 rounded-full border border-light-300 px-2 py-[1px] text-light-900 dark:border-dark-300 dark:text-dark-900",
            item.completed &&
              "border-green-600/40 text-green-700 dark:text-green-500",
            overdue && "border-red-500/50 text-red-600 dark:text-red-400",
          )}
          title={overdue ? t`Overdue` : undefined}
        >
          <HiOutlineCalendar className="h-3 w-3" />
          {dates.join(" – ")}
          {item.dueDate && item.dueReminderMinutes !== null && (
            <HiOutlineBell
              className="h-3 w-3"
              aria-label={reminderLabel(
                item.dueReminderMinutes,
                item.dueDateHasTime,
              )}
            />
          )}
        </span>
      )}
      {assignees.length > 0 && (
        <span className="isolate flex -space-x-1">
          {assignees.map((member) => (
            <Avatar
              key={member.publicId}
              size="xs"
              name={member.name}
              email={member.email}
              imageUrl={member.imageUrl}
            />
          ))}
        </span>
      )}
    </div>
  );
}

/**
 * A button that opens the item's sub-task settings: start and due dates with
 * optional times, a reminder, and the board members it's assigned to.
 */
export function ChecklistItemScheduleButton({
  item,
  cardPublicId,
  members,
  onOpenChange,
}: {
  item: ChecklistItemScheduleData;
  cardPublicId: string;
  members: AssignableMember[];
  /** Lets the row keep its hover actions visible while the panel is open */
  onOpenChange?: (isOpen: boolean) => void;
}) {
  const utils = api.useUtils();
  const { showPopup } = usePopup();
  const { workspace } = useWorkspace();
  const [isOpen, setIsOpen] = useState(false);
  const [editing, setEditing] = useState<"start" | "due" | null>(null);
  const [start, setStart] = useState<DateTimeValue>({
    date: item.startDate,
    hasTime: item.startDateHasTime,
  });
  const [due, setDue] = useState<DateTimeValue>({
    date: item.dueDate,
    hasTime: item.dueDateHasTime,
  });
  const [reminder, setReminder] = useState(item.dueReminderMinutes);

  const updateCachedItem = (
    change: (
      old: NonNullable<
        ReturnType<typeof utils.card.byId.getData>
      >["checklists"][number]["items"][number],
    ) => typeof old,
  ) =>
    utils.card.byId.setData({ cardPublicId }, (old) =>
      old
        ? {
            ...old,
            checklists: old.checklists.map((checklist) => ({
              ...checklist,
              items: checklist.items.map((ci) =>
                ci.publicId === item.publicId ? change(ci) : ci,
              ),
            })),
          }
        : old,
    );

  const onError = (
    header: string,
    context:
      | { previous?: ReturnType<typeof utils.card.byId.getData> }
      | undefined,
  ) => {
    if (context?.previous)
      utils.card.byId.setData({ cardPublicId }, context.previous);
    showPopup({
      header,
      message: t`Please try again later, or contact customer support.`,
      icon: "error",
    });
  };

  const updateItem = api.checklist.updateItem.useMutation({
    onMutate: async (vars) => {
      await utils.card.byId.cancel({ cardPublicId });
      const previous = utils.card.byId.getData({ cardPublicId });
      updateCachedItem((old) => ({
        ...old,
        startDate:
          vars.startDate !== undefined ? vars.startDate : old.startDate,
        startDateHasTime: vars.startDateHasTime ?? old.startDateHasTime,
        dueDate: vars.dueDate !== undefined ? vars.dueDate : old.dueDate,
        dueDateHasTime: vars.dueDateHasTime ?? old.dueDateHasTime,
        dueReminderMinutes:
          vars.dueReminderMinutes !== undefined
            ? vars.dueReminderMinutes
            : old.dueReminderMinutes,
      }));
      return { previous };
    },
    onError: (_err, _vars, context) =>
      onError(t`Unable to update checklist item`, context),
    onSettled: async () => {
      await invalidateCard(utils, cardPublicId);
    },
  });

  const toggleMember = api.checklist.addOrRemoveItemMember.useMutation({
    onMutate: async (vars) => {
      await utils.card.byId.cancel({ cardPublicId });
      const previous = utils.card.byId.getData({ cardPublicId });
      const member = members.find(
        (m) => m.publicId === vars.workspaceMemberPublicId,
      );
      updateCachedItem((old) => ({
        ...old,
        members: old.members.some(
          (m) => m.publicId === vars.workspaceMemberPublicId,
        )
          ? old.members.filter(
              (m) => m.publicId !== vars.workspaceMemberPublicId,
            )
          : [
              ...old.members,
              {
                publicId: vars.workspaceMemberPublicId,
                email: member?.email ?? "",
                user: null,
              },
            ],
      }));
      return { previous };
    },
    onError: (_err, _vars, context) =>
      onError(t`Unable to update assignees`, context),
    onSettled: async () => {
      await invalidateCard(utils, cardPublicId);
    },
  });

  const open = () => {
    setStart({ date: item.startDate, hasTime: item.startDateHasTime });
    setDue({ date: item.dueDate, hasTime: item.dueDateHasTime });
    setReminder(item.dueReminderMinutes);
    setEditing(null);
    setIsOpen(true);
    onOpenChange?.(true);
  };

  const close = () => {
    setIsOpen(false);
    onOpenChange?.(false);
    const startChanged = !sameValue(
      start,
      item.startDate,
      item.startDateHasTime,
    );
    const dueChanged = !sameValue(due, item.dueDate, item.dueDateHasTime);
    // Remind a day ahead when a due date is first added, like cards do
    const nextReminder =
      !item.dueDate && due.date && reminder === item.dueReminderMinutes
        ? (item.dueReminderMinutes ?? defaultDueReminderMinutes)
        : reminder;
    const reminderChanged = nextReminder !== item.dueReminderMinutes;
    if (!startChanged && !dueChanged && !reminderChanged) return;

    updateItem.mutate({
      checklistItemPublicId: item.publicId,
      ...(startChanged && {
        startDate: start.date,
        startDateHasTime: !!start.date && start.hasTime,
      }),
      ...(dueChanged && {
        dueDate: due.date,
        dueDateHasTime: !!due.date && due.hasTime,
      }),
      ...(reminderChanged && { dueReminderMinutes: nextReminder }),
    });
  };

  const dateField = (
    label: string,
    which: "start" | "due",
    value: DateTimeValue,
    setValue: (value: DateTimeValue) => void,
  ) => (
    <div className="flex flex-col gap-1">
      <span className="text-light-900 dark:text-dark-900">{label}</span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setEditing(editing === which ? null : which)}
          className={twMerge(
            "flex-1 rounded-[5px] border border-light-300 px-2 py-1 text-left hover:bg-light-200 dark:border-dark-300 dark:hover:bg-dark-200",
            editing === which && "border-blue-500 dark:border-blue-500",
          )}
        >
          {value.date
            ? formatDueDate(value.date, value.hasTime)
            : t`Add a date`}
        </button>
        {value.date && (
          <button
            type="button"
            aria-label={t`Remove date`}
            onClick={() => setValue({ date: null, hasTime: false })}
            className="rounded-md p-1 text-light-900 hover:bg-light-200 dark:text-dark-700 dark:hover:bg-dark-200"
          >
            <HiXMark size={14} />
          </button>
        )}
      </div>
      {editing === which && (
        <div className="rounded-md border border-light-200 dark:border-dark-200">
          <DateTimePicker
            value={value}
            onChange={setValue}
            weekStartsOn={workspace.weekStartDay}
          />
        </div>
      )}
    </div>
  );

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={t`Dates, reminder and assignees`}
        onClick={() => (isOpen ? close() : open())}
        className="rounded-md p-1 text-light-900 hover:bg-light-200 dark:text-dark-700 dark:hover:bg-dark-200"
      >
        <HiOutlineCalendar size={16} />
      </button>
      {isOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={close} />
          <div
            className="absolute right-0 top-full z-20 mt-1 flex max-h-[70vh] w-[282px] flex-col gap-3 overflow-y-auto rounded-md border border-light-200 bg-light-50 p-3 text-xs text-neutral-900 shadow-lg dark:border-dark-200 dark:bg-dark-100 dark:text-dark-1000"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {dateField(t`Start date`, "start", start, setStart)}
            {dateField(t`Due date`, "due", due, setDue)}
            {due.date && (
              <label className="flex flex-col gap-1">
                <span className="text-light-900 dark:text-dark-900">
                  {t`Reminder`}
                </span>
                <select
                  value={reminder ?? ""}
                  onChange={(e) =>
                    setReminder(
                      e.target.value === "" ? null : Number(e.target.value),
                    )
                  }
                  className="rounded-[5px] border-light-300 bg-light-50 py-1 text-xs dark:border-dark-300 dark:bg-dark-100"
                >
                  <option value="">{t`None`}</option>
                  {dueReminderOptions.map((minutes) => (
                    <option key={minutes} value={minutes}>
                      {reminderLabel(minutes, due.hasTime)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="flex flex-col gap-1">
              <span className="text-light-900 dark:text-dark-900">
                {t`Assigned to`}
              </span>
              {members.length === 0 && (
                <span className="text-light-800 dark:text-dark-800">
                  {t`No board members yet`}
                </span>
              )}
              {members.map((member) => {
                const assigned = item.members.some(
                  (m) => m.publicId === member.publicId,
                );
                return (
                  <label
                    key={member.publicId}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 hover:bg-light-200 dark:hover:bg-dark-200"
                  >
                    <input
                      type="checkbox"
                      checked={assigned}
                      onChange={() =>
                        toggleMember.mutate({
                          checklistItemPublicId: item.publicId,
                          workspaceMemberPublicId: member.publicId,
                        })
                      }
                      className="h-4 w-4 rounded border-light-500 text-blue-600 focus:ring-0 dark:border-dark-500 dark:bg-dark-100"
                    />
                    <Avatar
                      size="xs"
                      name={member.name}
                      email={member.email}
                      imageUrl={member.imageUrl}
                    />
                    <span className="truncate">{member.name}</span>
                  </label>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
