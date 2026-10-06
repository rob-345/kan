import { t } from "@lingui/core/macro";
import { HiXMark } from "react-icons/hi2";

import Button from "~/components/Button";
import { useModal } from "~/providers/modal";
import { usePopup } from "~/providers/popup";
import { api } from "~/utils/api";

export function DeleteGoogleChatSpaceConfirmation({
  workspacePublicId,
}: {
  workspacePublicId: string;
}) {
  const {
    closeModal,
    entityId: spacePublicId,
    entityLabel: spaceName,
  } = useModal();
  const { showPopup } = usePopup();
  const utils = api.useUtils();

  const deleteSpace = api.googleChat.delete.useMutation({
    onSuccess: () => {
      void utils.googleChat.list.invalidate({ workspacePublicId });
      showPopup({
        header: t`Google Chat space removed`,
        message: t`Kan will stop posting to this space.`,
        icon: "success",
      });
      closeModal();
    },
    onError: (error) => {
      showPopup({
        header: t`Unable to remove Google Chat space`,
        message: error.message,
        icon: "error",
      });
    },
  });

  return (
    <div>
      <div className="px-5 pt-5">
        <div className="flex w-full items-center justify-between pb-4 text-neutral-900 dark:text-dark-1000">
          <h2 className="text-sm font-bold">{t`Remove Google Chat space`}</h2>
          <button
            type="button"
            className="rounded p-1 hover:bg-light-300 focus:outline-none dark:hover:bg-dark-300"
            onClick={(e) => {
              e.preventDefault();
              closeModal();
            }}
          >
            <HiXMark size={18} className="text-light-900 dark:text-dark-900" />
          </button>
        </div>
        <p className="text-sm text-neutral-500 dark:text-dark-900">
          {t`Stop posting card updates to "${spaceName}"? Messages already in the space stay there.`}
        </p>
      </div>
      <div className="mt-8 flex items-center justify-end gap-3 border-t border-light-600 px-5 pb-5 pt-5 dark:border-dark-600">
        <Button variant="secondary" onClick={() => closeModal()}>
          {t`Cancel`}
        </Button>
        <Button
          variant="danger"
          isLoading={deleteSpace.isPending}
          onClick={() =>
            spacePublicId &&
            deleteSpace.mutate({ workspacePublicId, spacePublicId })
          }
        >
          {t`Remove`}
        </Button>
      </div>
    </div>
  );
}
