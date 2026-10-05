import type { ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { t } from "@lingui/core/macro";
import { useForm } from "react-hook-form";
import {
  HiArrowRightOnRectangle,
  HiEllipsisHorizontal,
  HiOutlineDocumentDuplicate,
  HiOutlinePlusSmall,
  HiOutlineSquaresPlus,
  HiOutlineTrash,
} from "react-icons/hi2";
import { IoArchiveOutline } from "react-icons/io5";

import { authClient } from "@kan/auth/client";

import type { ListDragData } from "../dnd/types";
import Dropdown from "~/components/Dropdown";
import { Tooltip } from "~/components/Tooltip";
import { usePermissions } from "~/hooks/usePermissions";
import { useModal } from "~/providers/modal";
import { usePopup } from "~/providers/popup";
import { api } from "~/utils/api";
import { isPlaceholderPublicId } from "~/utils/helpers";

interface ListProps {
  children: ReactNode;
  list: List;
  setSelectedPublicListId: (publicListId: PublicListId) => void;
  isTemplate?: boolean;
}

interface List {
  publicId: string;
  name: string;
  createdBy?: string | null;
}

interface FormValues {
  listPublicId: string;
  name: string;
}

type PublicListId = string;

export default function List({
  children,
  list,
  setSelectedPublicListId,
  isTemplate = false,
}: ListProps) {
  const { openModal } = useModal();
  const { showPopup } = usePopup();
  const utils = api.useUtils();
  const { canCreateCard, canCreateList, canEditList, canDeleteList } =
    usePermissions();
  const { data: session } = authClient.useSession();
  const isCreator = list.createdBy && session?.user.id === list.createdBy;
  const isOptimistic = isPlaceholderPublicId(list.publicId);
  const canEdit = canEditList || isCreator;
  const canDrag = !isOptimistic && (canEditList || isCreator);

  const openNewCardForm = (publicListId: PublicListId) => {
    if (!canCreateCard || isOptimistic) return;
    openModal("NEW_CARD");
    setSelectedPublicListId(publicListId);
  };

  const updateList = api.list.update.useMutation();

  const archiveList = api.list.archive.useMutation({
    onSuccess: async () => {
      showPopup({
        header: t`List archived`,
        message: t`You can restore it from the board's archived items.`,
        icon: "success",
      });
      await utils.board.byId.invalidate();
    },
    onError: () => {
      showPopup({
        header: t`Unable to archive list`,
        message: t`Please try again later, or contact customer support.`,
        icon: "error",
      });
    },
  });

  const { register, handleSubmit } = useForm<FormValues>({
    defaultValues: {
      listPublicId: list.publicId,
      name: list.name,
    },
    values: {
      listPublicId: list.publicId,
      name: list.name,
    },
  });

  const onSubmit = (values: FormValues) => {
    if (!canEdit || isOptimistic) return;
    updateList.mutate({
      listPublicId: values.listPublicId,
      name: values.name,
    });
  };

  const handleOpenDeleteListConfirmation = () => {
    setSelectedPublicListId(list.publicId);
    openModal("DELETE_LIST");
  };

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: list.publicId,
    data: { type: "LIST" } satisfies ListDragData,
    disabled: { draggable: !canDrag, droppable: false },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      data-board-draggable
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`dark-text-dark-1000 mr-5 h-fit min-w-[18rem] max-w-[18rem] snap-start rounded-md border border-light-400 bg-light-300 py-2 pl-2 pr-1 text-neutral-900 dark:border-dark-300 dark:bg-dark-100 md:snap-align-none ${
        canDrag ? (isDragging ? "cursor-grabbing" : "cursor-grab") : ""
      }`}
    >
      <div className="mb-2 flex justify-between">
        <form
          onSubmit={handleSubmit(onSubmit)}
          className="w-full focus-visible:outline-none"
        >
          <input
            id="name"
            type="text"
            aria-label={t`List name`}
            {...register("name")}
            onBlur={handleSubmit(onSubmit)}
            readOnly={!canEdit || isOptimistic}
            className="w-full border-0 bg-transparent px-4 pt-1 text-sm font-medium text-neutral-900 focus:ring-0 focus-visible:outline-none dark:text-dark-1000"
          />
        </form>
        <div className="flex items-center">
          <Tooltip
            content={!canCreateCard ? t`You don't have permission` : undefined}
          >
            <button
              className="mx-1 inline-flex h-fit items-center rounded-md p-1 px-1 text-sm font-semibold text-dark-50 hover:bg-light-400 disabled:cursor-not-allowed disabled:opacity-60 dark:hover:bg-dark-200"
              onClick={() => openNewCardForm(list.publicId)}
              disabled={!canCreateCard || isOptimistic}
              aria-label={t`Add card`}
            >
              <HiOutlinePlusSmall
                className="h-5 w-5 text-dark-900"
                aria-hidden="true"
              />
            </button>
          </Tooltip>
          {(() => {
            const dropdownItems = [
              ...(canCreateCard && !isOptimistic
                ? [
                    {
                      label: t`Add a card`,
                      action: () => openNewCardForm(list.publicId),
                      icon: (
                        <HiOutlineSquaresPlus className="h-[18px] w-[18px] text-dark-900" />
                      ),
                    },
                  ]
                : []),
              ...(!isOptimistic && canCreateList && canCreateCard
                ? [
                    {
                      label: t`Copy list`,
                      action: () =>
                        openModal("COPY_LIST", list.publicId, list.name),
                      icon: (
                        <HiOutlineDocumentDuplicate className="h-[18px] w-[18px] text-dark-900" />
                      ),
                    },
                  ]
                : []),
              ...(!isOptimistic && !isTemplate && canEdit
                ? [
                    {
                      label: t`Move list to board`,
                      action: () => openModal("MOVE_LIST", list.publicId),
                      icon: (
                        <HiArrowRightOnRectangle className="h-[18px] w-[18px] text-dark-900" />
                      ),
                    },
                    {
                      label: t`Archive list`,
                      action: () =>
                        archiveList.mutate({ listPublicId: list.publicId }),
                      icon: (
                        <IoArchiveOutline className="h-[18px] w-[18px] text-dark-900" />
                      ),
                      disabled: archiveList.isPending,
                    },
                  ]
                : []),
              ...(!isOptimistic && (canDeleteList || isCreator)
                ? [
                    {
                      label: t`Delete list`,
                      action: handleOpenDeleteListConfirmation,
                      icon: (
                        <HiOutlineTrash className="h-[18px] w-[18px] text-dark-900" />
                      ),
                    },
                  ]
                : []),
            ];

            if (dropdownItems.length === 0) {
              return null;
            }

            return (
              <div className="relative mr-1 inline-block">
                <Dropdown items={dropdownItems} ariaLabel={t`List options`}>
                  <HiEllipsisHorizontal className="h-5 w-5 text-dark-900" />
                </Dropdown>
              </div>
            );
          })()}
        </div>
      </div>
      {children}
    </div>
  );
}
