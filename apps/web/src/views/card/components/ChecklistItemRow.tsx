import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
} from "@dnd-kit/core";
import { t } from "@lingui/core/macro";
import { useState } from "react";
import { HiXMark } from "react-icons/hi2";
import { RiDraggable } from "react-icons/ri";
import { twMerge } from "tailwind-merge";

import type {
  AssignableMember,
  ChecklistItemScheduleData,
} from "./ChecklistItemSchedule";
import PlainTextEditor from "~/components/PlainTextEditor";
import { usePopup } from "~/providers/popup";
import { api } from "~/utils/api";
import { invalidateCard } from "~/utils/cardInvalidation";
import {
  ChecklistItemMeta,
  ChecklistItemScheduleButton,
} from "./ChecklistItemSchedule";

interface ChecklistItemRowProps {
  item: ChecklistItemScheduleData & {
    title: string;
    clientId?: string;
  };
  /** Board members the item can be assigned to */
  members: AssignableMember[];
  cardPublicId: string;
  onCreateNewItem?: () => void;
  viewOnly?: boolean;
  dragHandleAttributes?: DraggableAttributes;
  dragHandleListeners?: DraggableSyntheticListeners;
  isDragging?: boolean;
}

export default function ChecklistItemRow({
  item,
  members,
  cardPublicId,
  onCreateNewItem,
  viewOnly = false,
  dragHandleAttributes,
  dragHandleListeners,
  isDragging = false,
}: ChecklistItemRowProps) {
  const utils = api.useUtils();
  const { showPopup } = usePopup();
  const [completed, setCompleted] = useState(item.completed);
  const [isScheduleOpen, setIsScheduleOpen] = useState(false);

  const updateItem = api.checklist.updateItem.useMutation({
    onMutate: async (vars) => {
      await utils.card.byId.cancel({ cardPublicId });
      const previous = utils.card.byId.getData({ cardPublicId });
      utils.card.byId.setData({ cardPublicId }, (old) => {
        if (!old) return old as any;
        const updatedChecklists = old.checklists.map((cl) => ({
          ...cl,
          items: cl.items.map((ci) =>
            ci.publicId === item.publicId
              ? {
                  ...ci,
                  ...(vars.title !== undefined ? { title: vars.title } : {}),
                  ...(vars.completed !== undefined
                    ? { completed: vars.completed }
                    : {}),
                }
              : ci,
          ),
        }));
        return { ...old, checklists: updatedChecklists } as typeof old;
      });
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous)
        utils.card.byId.setData({ cardPublicId }, ctx.previous);
      showPopup({
        header: t`Unable to update checklist item`,
        message: t`Please try again later, or contact customer support.`,
        icon: "error",
      });
    },
    onSettled: async () => {
      await invalidateCard(utils, cardPublicId);
    },
  });

  const deleteItem = api.checklist.deleteItem.useMutation({
    onMutate: async () => {
      await utils.card.byId.cancel({ cardPublicId });
      const previous = utils.card.byId.getData({ cardPublicId });
      utils.card.byId.setData({ cardPublicId }, (old) => {
        if (!old) return old as any;
        const updatedChecklists = old.checklists.map((cl) => ({
          ...cl,
          items: cl.items.filter((ci) => ci.publicId !== item.publicId),
        }));
        return { ...old, checklists: updatedChecklists } as typeof old;
      });
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous)
        utils.card.byId.setData({ cardPublicId }, ctx.previous);
      showPopup({
        header: t`Unable to delete checklist item`,
        message: t`Please try again later, or contact customer support.`,
        icon: "error",
      });
    },
    onSettled: async () => {
      await invalidateCard(utils, cardPublicId);
    },
  });

  const handleToggleCompleted = () => {
    if (viewOnly) return;
    setCompleted((prev) => !prev);
    updateItem.mutate({
      checklistItemPublicId: item.publicId,
      completed: !completed,
    });
  };

  const commitTitle = (plain: string) => {
    if (!plain || plain === item.title) return;
    updateItem.mutate({
      checklistItemPublicId: item.publicId,
      title: plain,
    });
  };

  const handleDelete = () => {
    if (viewOnly) return;
    deleteItem.mutate({ checklistItemPublicId: item.publicId });
  };

  return (
    <div
      className={twMerge(
        "group relative flex items-start gap-3 rounded-md py-2 pl-4 hover:bg-light-100 dark:hover:bg-dark-100",
        isDragging && "opacity-80",
      )}
    >
      {!viewOnly && (
        <div
          {...dragHandleAttributes}
          {...dragHandleListeners}
          className="absolute left-0 top-1/2 flex h-[20px] w-[20px] -translate-x-full -translate-y-1/2 cursor-grab items-center justify-center pr-1 opacity-0 transition-opacity group-hover:opacity-75 hover:opacity-100 active:cursor-grabbing"
        >
          <RiDraggable className="h-4 w-4 text-light-700 dark:text-dark-700" />
        </div>
      )}

      {viewOnly && <div className="w-[20px] flex-shrink-0" />}

      <label
        className={`relative mt-[2px] inline-flex h-[16px] w-[16px] flex-shrink-0 items-center justify-center`}
      >
        <input
          type="checkbox"
          checked={completed}
          onChange={(e) => {
            if (viewOnly) {
              e.preventDefault();
              return;
            }
            handleToggleCompleted();
          }}
          className={twMerge(
            "h-[16px] w-[16px] appearance-none rounded-md border border-light-500 bg-transparent outline-none ring-0 checked:bg-blue-600 focus:shadow-none focus:ring-0 focus:ring-offset-0 focus-visible:outline-none dark:border-dark-500 dark:hover:border-dark-500",
            viewOnly ? "cursor-default" : "cursor-pointer",
          )}
        />
      </label>

      <div className={twMerge("min-w-0 flex-1", viewOnly ? "pr-2" : "pr-16")}>
        <PlainTextEditor
          key={item.clientId ?? item.publicId}
          content={item.title}
          readOnly={viewOnly}
          placeholder={t`Add details...`}
          onBlur={commitTitle}
          onEnter={(plain) => {
            commitTitle(plain);
            onCreateNewItem?.();
          }}
          onEscape={() => undefined}
          className={twMerge(
            "m-0 min-h-[20px] w-full p-0 text-sm leading-[20px] text-light-950 dark:text-dark-950",
            viewOnly && "cursor-default",
          )}
        />
        <ChecklistItemMeta item={{ ...item, completed }} members={members} />
      </div>

      {!viewOnly && (
        <div
          className={twMerge(
            "absolute right-1 top-1.5 flex items-center opacity-0 focus-within:opacity-100 group-hover:opacity-100",
            isScheduleOpen && "z-20 opacity-100",
          )}
        >
          {/* Sub-task settings need the item to be saved first */}
          {!item.publicId.startsWith("PLACEHOLDER_") && (
            <ChecklistItemScheduleButton
              item={item}
              cardPublicId={cardPublicId}
              members={members}
              onOpenChange={setIsScheduleOpen}
            />
          )}
          <button
            type="button"
            aria-label={t`Delete checklist item`}
            onClick={handleDelete}
            className="rounded-md p-1 text-light-900 hover:bg-light-200 dark:text-dark-700 dark:hover:bg-dark-200"
          >
            <HiXMark size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
