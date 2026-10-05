import { useRouter } from "next/router";
import { t } from "@lingui/core/macro";
import {
  HiArrowRightOnRectangle,
  HiEllipsisHorizontal,
  HiEye,
  HiLink,
  HiOutlineDocumentDuplicate,
  HiOutlineEye,
  HiOutlineStar,
  HiOutlineTrash,
  HiStar,
} from "react-icons/hi2";
import { IoArchiveOutline, IoFileTrayFullOutline } from "react-icons/io5";

import Dropdown from "~/components/Dropdown";
import { usePermissions } from "~/hooks/usePermissions";
import { useModal } from "~/providers/modal";
import { usePopup } from "~/providers/popup";
import { api } from "~/utils/api";

export default function BoardDropdown({
  isTemplate,
  isLoading,
  isArchived,
  boardPublicId,
  isFavorite,
  isWatching,
  boardName,
}: {
  isTemplate: boolean;
  isLoading: boolean;
  boardPublicId: string;
  isArchived?: boolean;
  isFavorite?: boolean;
  isWatching?: boolean;
  boardName?: string;
}) {
  const router = useRouter();
  const { openModal } = useModal();
  const { showPopup } = usePopup();
  const { canEditBoard, canDeleteBoard, canCreateBoard, canArchiveBoard } =
    usePermissions();
  const utils = api.useUtils();

  const updateBoard = api.board.update.useMutation({
    onSuccess: (_data, variables) => {
      void utils.board.all.invalidate();
      void utils.board.byId.invalidate();
      if (variables.isArchived !== undefined) {
        showPopup({
          header: variables.isArchived
            ? t`Board archived`
            : t`Board unarchived`,
          message: variables.isArchived
            ? t`The board has been archived.`
            : t`The board has been unarchived.`,
          icon: "success",
        });
        void router.push(`/boards`);
      } else if (variables.favorite !== undefined) {
        showPopup({
          header: variables.favorite
            ? t`Added to favorites`
            : t`Removed from favorites`,
          message: variables.favorite
            ? t`${boardName ?? "Board"} has been added to your favorites.`
            : t`${boardName ?? "Board"} has been removed from your favorites.`,
          icon: "success",
        });
      }
    },
    onError: () => {
      showPopup({
        header: t`Unable to update board`,
        message: t`Please try again later, or contact customer support.`,
        icon: "error",
      });
    },
  });

  const setWatching = api.board.setWatching.useMutation({
    onSuccess: ({ watching }) => {
      void utils.board.byId.invalidate();
      showPopup({
        header: watching ? t`Watching board` : t`Stopped watching board`,
        message: watching
          ? t`You'll be notified about activity on every card in this board.`
          : t`You'll no longer be notified about this board.`,
        icon: "success",
      });
    },
    onError: () => {
      showPopup({
        header: t`Unable to update watching`,
        message: t`Please try again later, or contact customer support.`,
        icon: "error",
      });
    },
  });

  const handleToggleFavorite = () => {
    updateBoard.mutate({
      boardPublicId,
      favorite: !isFavorite,
    });
  };

  const handleArchiveOrUnarchive = () => {
    updateBoard.mutate({
      boardPublicId,
      isArchived: !isArchived,
    });
  };

  const isArchiveActionPending = updateBoard.isPending;

  const items = [
    ...(!isTemplate && canCreateBoard
      ? [
          {
            label: t`Make template`,
            action: () => openModal("CREATE_TEMPLATE"),
            icon: (
              <HiOutlineDocumentDuplicate className="h-[16px] w-[16px] text-dark-900" />
            ),
          },
        ]
      : []),
    ...(!isTemplate && canEditBoard
      ? [
          {
            label: t`Edit board URL`,
            action: () => openModal("UPDATE_BOARD_SLUG"),
            icon: <HiLink className="h-[16px] w-[16px] text-dark-900" />,
          },
        ]
      : []),
    ...(!isTemplate && canArchiveBoard
      ? [
          {
            label: isArchived ? t`Unarchive board` : t`Archive board`,
            action: handleArchiveOrUnarchive,
            icon: (
              <IoArchiveOutline className="h-[16px] w-[16px] text-dark-900" />
            ),
          },
        ]
      : []),
    ...(!isTemplate && canEditBoard
      ? [
          {
            label: t`Move to workspace`,
            action: () => openModal("MOVE_BOARD"),
            icon: (
              <HiArrowRightOnRectangle className="h-[16px] w-[16px] text-dark-900" />
            ),
          },
        ]
      : []),
    ...(!isTemplate
      ? [
          {
            label: isWatching ? t`Stop watching board` : t`Watch board`,
            action: () =>
              setWatching.mutate({ boardPublicId, watching: !isWatching }),
            icon: isWatching ? (
              <HiEye className="h-[16px] w-[16px] text-dark-900" />
            ) : (
              <HiOutlineEye className="h-[16px] w-[16px] text-dark-900" />
            ),
            disabled: setWatching.isPending,
          },
          {
            label: t`Archived items`,
            action: () => openModal("ARCHIVED_ITEMS"),
            icon: (
              <IoFileTrayFullOutline className="h-[16px] w-[16px] text-dark-900" />
            ),
          },
        ]
      : []),
    {
      label: isFavorite ? t`Remove from favorites` : t`Add to favorites`,
      action: handleToggleFavorite,
      icon: isFavorite ? (
        <HiStar className="h-[16px] w-[16px] text-dark-900" />
      ) : (
        <HiOutlineStar className="h-[16px] w-[16px] text-dark-900" />
      ),
    },
    ...(canDeleteBoard
      ? [
          {
            label: isTemplate ? t`Delete template` : t`Delete board`,
            action: () => openModal("DELETE_BOARD"),
            icon: (
              <HiOutlineTrash className="h-[16px] w-[16px] text-dark-900" />
            ),
          },
        ]
      : []),
  ];

  if (items.length === 0) {
    return null;
  }

  return (
    <Dropdown
      disabled={isLoading || isArchiveActionPending}
      items={items}
      ariaLabel={t`Board options`}
      menuGap="md"
    >
      <HiEllipsisHorizontal className="h-5 w-5 text-dark-900" />
    </Dropdown>
  );
}
