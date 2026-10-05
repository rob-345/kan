import { t } from "@lingui/core/macro";
import { HiEye, HiOutlineEye } from "react-icons/hi2";

import { usePopup } from "~/providers/popup";
import { api } from "~/utils/api";

export function WatchButton({
  isWatching,
  onToggle,
  isPending,
  label,
}: {
  isWatching: boolean;
  onToggle: () => void;
  isPending?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={isPending}
      aria-pressed={isWatching}
      title={
        isWatching
          ? t`Watching: you get notified about activity. Click to stop.`
          : t`Watch to get notified about activity`
      }
      className="flex h-7 items-center gap-1 rounded-[5px] px-1.5 text-xs text-light-900 hover:bg-light-200 disabled:opacity-60 dark:text-dark-900 dark:hover:bg-dark-200"
    >
      {isWatching ? (
        <HiEye className="h-4 w-4" />
      ) : (
        <HiOutlineEye className="h-4 w-4" />
      )}
      {label ?? (isWatching ? t`Watching` : t`Watch`)}
    </button>
  );
}

export function CardWatchButton({
  cardPublicId,
  isWatching,
}: {
  cardPublicId: string;
  isWatching: boolean;
}) {
  const utils = api.useUtils();
  const { showPopup } = usePopup();

  const setWatching = api.card.setWatching.useMutation({
    onMutate: async ({ watching }) => {
      await utils.card.byId.cancel({ cardPublicId });
      const previousCard = utils.card.byId.getData({ cardPublicId });
      utils.card.byId.setData({ cardPublicId }, (oldCard) =>
        oldCard ? { ...oldCard, isWatching: watching } : oldCard,
      );
      return { previousCard };
    },
    onError: (_error, _input, context) => {
      utils.card.byId.setData({ cardPublicId }, context?.previousCard);
      showPopup({
        header: t`Unable to update watching`,
        message: t`Please try again later, or contact customer support.`,
        icon: "error",
      });
    },
  });

  return (
    <WatchButton
      isWatching={isWatching}
      isPending={setWatching.isPending}
      onToggle={() =>
        setWatching.mutate({ cardPublicId, watching: !isWatching })
      }
    />
  );
}
