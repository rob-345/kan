import { t } from "@lingui/core/macro";

import { useModal } from "~/providers/modal";
import { usePopup } from "~/providers/popup";
import { useWorkspace } from "~/providers/workspace";
import { api } from "~/utils/api";

export function MoveListModal({
  currentBoardPublicId,
}: {
  currentBoardPublicId: string;
}) {
  const { entityId: listPublicId, closeModal } = useModal();
  const { workspace } = useWorkspace();
  const { showPopup } = usePopup();
  const utils = api.useUtils();

  const { data: boards, isLoading } = api.board.all.useQuery(
    { workspacePublicId: workspace.publicId, type: "regular" },
    { enabled: workspace.publicId.length >= 12 },
  );

  const moveList = api.list.move.useMutation({
    onSuccess: async () => {
      closeModal();
      showPopup({
        header: t`List moved`,
        message: t`The list and its cards are now at the end of the other board.`,
        icon: "success",
      });
      await utils.board.byId.invalidate();
    },
    onError: () => {
      showPopup({
        header: t`Unable to move list`,
        message: t`Please try again later, or contact customer support.`,
        icon: "error",
      });
    },
  });

  const targetBoards =
    boards?.filter((board) => board.publicId !== currentBoardPublicId) ?? [];

  return (
    <div className="p-4">
      <h2 className="mb-4 text-lg font-semibold text-light-1000 dark:text-dark-1000">
        {t`Move list to board`}
      </h2>
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-10 w-full animate-pulse rounded bg-light-200 dark:bg-dark-300"
            />
          ))}
        </div>
      ) : targetBoards.length === 0 ? (
        <p className="py-4 text-sm text-light-900 dark:text-dark-900">
          {t`There are no other boards in this workspace.`}
        </p>
      ) : (
        <ul className="max-h-[60vh] space-y-1 overflow-y-auto pr-1">
          {targetBoards.map((board) => (
            <li key={board.publicId}>
              <button
                type="button"
                disabled={moveList.isPending}
                onClick={() =>
                  listPublicId &&
                  moveList.mutate({
                    listPublicId,
                    boardPublicId: board.publicId,
                  })
                }
                className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-light-200 disabled:opacity-50 dark:hover:bg-dark-400"
              >
                {board.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
