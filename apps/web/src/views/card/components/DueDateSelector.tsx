import { t } from "@lingui/core/macro";
import { useEffect, useState } from "react";
import { HiMiniPlus } from "react-icons/hi2";

import { defaultDueReminderMinutes } from "@kan/shared/constants";

import type { DateTimeValue } from "~/components/DateTimePicker";
import DateTimePicker from "~/components/DateTimePicker";
import { usePopup } from "~/providers/popup";
import { useWorkspace } from "~/providers/workspace";
import { api } from "~/utils/api";
import { invalidateCard } from "~/utils/cardInvalidation";
import { formatDueDate } from "~/utils/dueDates";

interface DueDateSelectorProps {
  cardPublicId: string;
  dueDate: Date | null | undefined;
  /** Whether the date carries a time of day */
  hasTime?: boolean;
  isLoading?: boolean;
  disabled?: boolean;
  /** Which card date this selector edits; defaults to the due date. */
  field?: "dueDate" | "startDate";
}

export function DueDateSelector({
  cardPublicId,
  dueDate,
  hasTime = false,
  isLoading = false,
  disabled = false,
  field = "dueDate",
}: DueDateSelectorProps) {
  const { showPopup } = usePopup();
  const { workspace } = useWorkspace();
  const utils = api.useUtils();
  const [isOpen, setIsOpen] = useState(false);
  const [pending, setPending] = useState<DateTimeValue>({
    date: dueDate ?? null,
    hasTime,
  });
  const hasTimeField =
    field === "startDate" ? "startDateHasTime" : "dueDateHasTime";

  // Sync the pending value with the saved one when it changes externally
  useEffect(() => {
    if (!isOpen) {
      setPending({ date: dueDate ?? null, hasTime });
    }
  }, [dueDate, hasTime, isOpen]);

  const updateDueDate = api.card.update.useMutation({
    onMutate: async (update) => {
      await utils.card.byId.cancel();

      const previousCard = utils.card.byId.getData({ cardPublicId });

      utils.card.byId.setData({ cardPublicId }, (oldCard) => {
        if (!oldCard) return oldCard;

        return {
          ...oldCard,
          [field]:
            update[field] !== undefined
              ? (update[field] as Date | null)
              : oldCard[field],
          [hasTimeField]: update[hasTimeField] ?? oldCard[hasTimeField],
        };
      });

      return { previousCard };
    },
    onError: (_error, _update, context) => {
      utils.card.byId.setData({ cardPublicId }, context?.previousCard);
      showPopup({
        header:
          field === "startDate"
            ? t`Unable to update start date`
            : t`Unable to update due date`,
        message: t`Please try again later, or contact customer support.`,
        icon: "error",
      });
    },
    onSettled: async () => {
      await invalidateCard(utils, cardPublicId);
      await utils.board.byId.invalidate();
    },
  });

  const handleBackdropClick = () => {
    const dueIsNull = !dueDate;
    // Only fire the mutation if the date or its time actually changed
    const changed =
      (pending.date?.getTime() ?? null) !== (dueDate?.getTime() ?? null) ||
      (!!pending.date && pending.hasTime !== hasTime);

    // Close popover immediately
    setIsOpen(false);

    // Fire mutation if date changed (optimistic update will handle UI)
    if (changed) {
      updateDueDate.mutate({
        cardPublicId,
        [field]: pending.date,
        [hasTimeField]: !!pending.date && pending.hasTime,
        // Remind members a day ahead when a due date is first added
        ...(field === "dueDate" &&
          dueIsNull && { dueReminderMinutes: defaultDueReminderMinutes }),
      });
    }
  };

  return (
    <div className="relative flex w-full items-center text-left">
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={isLoading || disabled}
        className={`flex h-full w-full items-center rounded-[5px] border-[1px] border-light-50 py-1 pl-2 text-left text-xs text-neutral-900 dark:border-dark-50 dark:text-dark-1000 ${disabled ? "cursor-not-allowed opacity-60" : "hover:border-light-300 hover:bg-light-200 dark:hover:border-dark-200 dark:hover:bg-dark-100"}`}
      >
        {dueDate ? (
          <span>{formatDueDate(dueDate, hasTime)}</span>
        ) : (
          <>
            <HiMiniPlus size={22} className="pr-2" />
            {field === "startDate" ? t`Set start date` : t`Set due date`}
          </>
        )}
      </button>
      {isOpen && !disabled && (
        <>
          <div className="fixed inset-0 z-10" onClick={handleBackdropClick} />
          <div
            className="absolute -left-8 top-full z-20 mt-2 rounded-md border border-light-200 bg-light-50 shadow-lg dark:border-dark-200 dark:bg-dark-100"
            onClick={(e) => {
              e.stopPropagation();
            }}
            onMouseDown={(e) => {
              e.stopPropagation();
            }}
          >
            <DateTimePicker
              value={pending}
              onChange={setPending}
              weekStartsOn={workspace.weekStartDay}
            />
          </div>
        </>
      )}
    </div>
  );
}
