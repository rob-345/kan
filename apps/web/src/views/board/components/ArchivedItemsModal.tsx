import { t } from "@lingui/core/macro";
import { formatDistanceToNow } from "date-fns";
import { useState } from "react";

import Button from "~/components/Button";
import { usePermissions } from "~/hooks/usePermissions";
import { usePopup } from "~/providers/popup";
import { api } from "~/utils/api";

type Tab = "cards" | "lists";

export function ArchivedItemsModal({
  boardPublicId,
}: {
  boardPublicId: string;
}) {
  const utils = api.useUtils();
  const { showPopup } = usePopup();
  const { canEditCard, canDeleteCard, canEditList, canDeleteList } =
    usePermissions();
  const [tab, setTab] = useState<Tab>("cards");

  const { data, isLoading } = api.card.archived.useQuery(
    { boardPublicId },
    { enabled: boardPublicId.length >= 12 },
  );

  const refresh = async () => {
    await Promise.all([
      utils.card.archived.invalidate({ boardPublicId }),
      utils.board.byId.invalidate(),
    ]);
  };

  const onError = (header: string) => () =>
    showPopup({
      header,
      message: t`Please try again later, or contact customer support.`,
      icon: "error",
    });

  const restoreCard = api.card.restore.useMutation({
    onSuccess: refresh,
    onError: onError(t`Unable to restore card`),
  });
  const deleteCard = api.card.deleteArchived.useMutation({
    onSuccess: refresh,
    onError: onError(t`Unable to delete card`),
  });
  const restoreList = api.list.restore.useMutation({
    onSuccess: refresh,
    onError: onError(t`Unable to restore list`),
  });
  const deleteList = api.list.deleteArchived.useMutation({
    onSuccess: refresh,
    onError: onError(t`Unable to delete list`),
  });

  const rows =
    tab === "cards"
      ? (data?.cards ?? []).map((card) => ({
          publicId: card.publicId,
          name: card.title,
          detail: t`in ${card.listName}`,
          archivedAt: card.archivedAt,
        }))
      : (data?.lists ?? []).map((list) => ({
          publicId: list.publicId,
          name: list.name,
          detail: null,
          archivedAt: list.archivedAt,
        }));

  const canRestore = tab === "cards" ? canEditCard : canEditList;
  const canDelete = tab === "cards" ? canDeleteCard : canDeleteList;

  return (
    <div className="p-5">
      <h2 className="text-md mb-4 font-medium text-neutral-900 dark:text-dark-1000">
        {t`Archived items`}
      </h2>
      <div className="mb-4 flex gap-1 border-b border-light-300 dark:border-dark-300">
        {(["cards", "lists"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${tab === value ? "border-neutral-900 font-medium text-neutral-900 dark:border-dark-1000 dark:text-dark-1000" : "border-transparent text-light-900 dark:text-dark-900"}`}
          >
            {value === "cards" ? t`Cards` : t`Lists`}
          </button>
        ))}
      </div>
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-10 w-full animate-pulse rounded bg-light-200 dark:bg-dark-300"
            />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-light-900 dark:text-dark-900">
          {tab === "cards" ? t`No archived cards` : t`No archived lists`}
        </p>
      ) : (
        <ul className="max-h-[60vh] space-y-1 overflow-y-auto pr-1">
          {rows.map((row) => (
            <li
              key={row.publicId}
              className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-light-200 dark:hover:bg-dark-200"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-neutral-900 dark:text-dark-1000">
                  {row.name}
                </p>
                <p className="text-xs text-light-900 dark:text-dark-900">
                  {[
                    row.detail,
                    row.archivedAt &&
                      t`archived ${formatDistanceToNow(row.archivedAt, { addSuffix: true })}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                {canRestore && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      tab === "cards"
                        ? restoreCard.mutate({ cardPublicId: row.publicId })
                        : restoreList.mutate({ listPublicId: row.publicId })
                    }
                  >
                    {t`Restore`}
                  </Button>
                )}
                {canDelete && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      const confirmed = window.confirm(
                        tab === "cards"
                          ? t`Delete this card for good? It can't be restored afterwards.`
                          : t`Delete this list and its cards for good? They can't be restored afterwards.`,
                      );
                      if (!confirmed) return;
                      if (tab === "cards") {
                        deleteCard.mutate({ cardPublicId: row.publicId });
                      } else {
                        deleteList.mutate({ listPublicId: row.publicId });
                      }
                    }}
                  >
                    {t`Delete`}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
