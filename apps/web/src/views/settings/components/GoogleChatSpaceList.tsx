import { t } from "@lingui/core/macro";
import { HiEllipsisHorizontal } from "react-icons/hi2";
import { twMerge } from "tailwind-merge";

import type { GoogleChatSpaceModalState } from "./GoogleChatSpaceModal";
import Dropdown from "~/components/Dropdown";
import { useModal } from "~/providers/modal";
import { usePopup } from "~/providers/popup";
import { api } from "~/utils/api";
import { getGoogleChatEventLabels } from "./googleChatEventLabels";

export default function GoogleChatSpaceList({
  workspacePublicId,
}: {
  workspacePublicId: string;
}) {
  const { openModal, setModalState } = useModal();
  const { showPopup } = usePopup();

  const { data: spaces, isLoading } = api.googleChat.list.useQuery({
    workspacePublicId,
  });

  const testSpace = api.googleChat.test.useMutation({
    onSuccess: (result) => {
      showPopup(
        result.success
          ? {
              header: t`Test message sent`,
              message: t`Check the space in Google Chat.`,
              icon: "success",
            }
          : {
              header: t`Test failed`,
              message:
                result.error ?? t`Google Chat didn't accept the message.`,
              icon: "error",
            },
      );
    },
    onError: (error) => {
      showPopup({
        header: t`Unable to send test message`,
        message: error.message,
        icon: "error",
      });
    },
  });

  if (isLoading) {
    return (
      <div className="h-16 animate-pulse rounded-lg bg-light-200 dark:bg-dark-200" />
    );
  }

  if (!spaces?.length) {
    return (
      <div className="rounded-lg border border-light-300 bg-light-50 p-8 text-center dark:border-dark-300 dark:bg-dark-100">
        <p className="text-sm text-neutral-500 dark:text-dark-900">
          {t`No Google Chat spaces yet. Add one to post card updates to your team.`}
        </p>
      </div>
    );
  }

  const eventLabels = getGoogleChatEventLabels();

  return (
    <ul className="divide-y divide-light-600 rounded-lg border border-light-300 bg-light-50 dark:divide-dark-600 dark:border-dark-300 dark:bg-dark-100">
      {spaces.map((space) => (
        <li key={space.publicId} className="flex items-start gap-4 p-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-medium text-light-1000 dark:text-dark-1000">
                {space.name}
              </p>
              <span
                className={twMerge(
                  "inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset",
                  space.active
                    ? "bg-emerald-500/10 text-emerald-400 ring-emerald-500/20"
                    : "bg-gray-500/10 text-gray-400 ring-gray-500/20",
                )}
              >
                {space.active ? t`Active` : t`Paused`}
              </span>
            </div>
            <p className="mt-1 text-sm text-neutral-500 dark:text-dark-900">
              {space.board ? space.board.name : t`All boards`}
              {" · "}
              {space.events.map((event) => eventLabels[event]).join(", ")}
            </p>
          </div>
          <Dropdown
            ariaLabel={t`Google Chat space options`}
            items={[
              {
                label: t`Edit`,
                action: () => {
                  const state: GoogleChatSpaceModalState = {
                    publicId: space.publicId,
                    name: space.name,
                    boardPublicId: space.board?.publicId ?? null,
                    events: space.events,
                    active: space.active,
                  };
                  setModalState("EDIT_GOOGLE_CHAT_SPACE", state);
                  openModal(
                    "EDIT_GOOGLE_CHAT_SPACE",
                    space.publicId,
                    space.name,
                  );
                },
              },
              {
                label: t`Send test message`,
                action: () =>
                  testSpace.mutate({
                    workspacePublicId,
                    spacePublicId: space.publicId,
                  }),
              },
              {
                label: t`Remove`,
                action: () =>
                  openModal(
                    "DELETE_GOOGLE_CHAT_SPACE",
                    space.publicId,
                    space.name,
                  ),
              },
            ]}
          >
            <HiEllipsisHorizontal
              size={25}
              className="text-light-900 dark:text-dark-900"
            />
          </Dropdown>
        </li>
      ))}
    </ul>
  );
}
