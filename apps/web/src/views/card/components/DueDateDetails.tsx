import { t } from "@lingui/core/macro";

import { dueReminderOptions } from "@kan/shared/constants";

import { usePopup } from "~/providers/popup";
import { api } from "~/utils/api";
import { invalidateCard } from "~/utils/cardInvalidation";
import { reminderLabel } from "~/utils/dueDates";

export function DueDateDetails({
  cardPublicId,
  dueDateCompleted,
  dueReminderMinutes,
  dueDateHasTime = false,
  disabled = false,
}: {
  cardPublicId: string;
  dueDateCompleted: boolean;
  dueReminderMinutes: number | null;
  /** Whole-day due dates remind from 09:00 that day */
  dueDateHasTime?: boolean;
  disabled?: boolean;
}) {
  const utils = api.useUtils();
  const { showPopup } = usePopup();

  const updateCard = api.card.update.useMutation({
    onMutate: async (update) => {
      await utils.card.byId.cancel({ cardPublicId });
      const previousCard = utils.card.byId.getData({ cardPublicId });
      utils.card.byId.setData({ cardPublicId }, (oldCard) =>
        oldCard
          ? {
              ...oldCard,
              dueDateCompleted:
                update.dueDateCompleted ?? oldCard.dueDateCompleted,
              dueReminderMinutes:
                update.dueReminderMinutes !== undefined
                  ? update.dueReminderMinutes
                  : oldCard.dueReminderMinutes,
            }
          : oldCard,
      );
      return { previousCard };
    },
    onError: (_error, _update, context) => {
      utils.card.byId.setData({ cardPublicId }, context?.previousCard);
      showPopup({
        header: t`Unable to update due date`,
        message: t`Please try again later, or contact customer support.`,
        icon: "error",
      });
    },
    onSettled: async () => {
      await invalidateCard(utils, cardPublicId);
      await utils.board.byId.invalidate();
    },
  });

  return (
    <div className="flex w-full flex-col gap-2 pl-2 text-xs text-neutral-900 dark:text-dark-1000">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={dueDateCompleted}
          disabled={disabled}
          onChange={(e) =>
            updateCard.mutate({
              cardPublicId,
              dueDateCompleted: e.target.checked,
            })
          }
          className="h-4 w-4 rounded border-light-500 text-green-600 focus:ring-0 dark:border-dark-500 dark:bg-dark-100"
        />
        {t`Mark complete`}
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-light-900 dark:text-dark-900">{t`Reminder`}</span>
        <select
          value={dueReminderMinutes ?? ""}
          disabled={disabled}
          onChange={(e) =>
            updateCard.mutate({
              cardPublicId,
              dueReminderMinutes:
                e.target.value === "" ? null : Number(e.target.value),
            })
          }
          className="rounded-[5px] border-light-300 bg-light-50 py-1 text-xs dark:border-dark-300 dark:bg-dark-100"
        >
          <option value="">{t`None`}</option>
          {dueReminderOptions.map((minutes) => (
            <option key={minutes} value={minutes}>
              {reminderLabel(minutes, dueDateHasTime)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
