import { useRouter } from "next/router";
import { Popover, Transition } from "@headlessui/react";
import { t } from "@lingui/core/macro";
import { format, formatDistanceToNow } from "date-fns";
import { Fragment } from "react";
import { HiOutlineBell } from "react-icons/hi2";
import { twMerge } from "tailwind-merge";

import type { RouterOutputs } from "~/utils/api";
import { api } from "~/utils/api";

type Notification = RouterOutputs["notification"]["list"][number];

const UNREAD_POLL_INTERVAL_MS = 60_000;

const stripHtml = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const describe = (notification: Notification) => {
  const actor = notification.actorName ?? t`Someone`;
  const card = notification.card?.title ?? t`a card`;

  switch (notification.type) {
    case "mention":
      return t`${actor} mentioned you on ${card}`;
    case "card.comment.added":
      return t`${actor} commented on ${card}`;
    case "card.moved":
      return notification.fromListName && notification.toListName
        ? t`${actor} moved ${card} from ${notification.fromListName} to ${notification.toListName}`
        : t`${actor} moved ${card}`;
    case "card.dueDate.changed":
      return notification.dueDate
        ? t`${actor} set ${card} to be due ${format(new Date(notification.dueDate), "MMM d, yyyy")}`
        : t`${actor} removed the due date from ${card}`;
    case "card.archived":
      return t`${actor} archived ${card}`;
    case "card.member.added":
      return t`${actor} added you to ${card}`;
    case "card.due.reminder":
      return notification.dueDate
        ? t`${card} is due ${formatDistanceToNow(new Date(notification.dueDate), { addSuffix: true })}`
        : t`${card} is due soon`;
    case "workspace.member.added":
      return t`You were added to a workspace`;
    case "workspace.member.removed":
      return t`You were removed from a workspace`;
    case "workspace.role.changed":
      return t`Your workspace role changed`;
    default:
      return t`New activity`;
  }
};

export default function NotificationsMenu({
  isCollapsed = false,
}: {
  isCollapsed?: boolean;
}) {
  const router = useRouter();
  const utils = api.useUtils();

  const { data: unread } = api.notification.unreadCount.useQuery(undefined, {
    refetchInterval: UNREAD_POLL_INTERVAL_MS,
  });
  const unreadCount = unread?.count ?? 0;

  const {
    data: notifications,
    isLoading,
    refetch,
  } = api.notification.list.useQuery({ limit: 50 }, { enabled: false });

  const markRead = api.notification.markRead.useMutation({
    onSettled: async () => {
      await Promise.all([
        utils.notification.unreadCount.invalidate(),
        utils.notification.list.invalidate(),
      ]);
    },
  });

  const openNotification = (notification: Notification, close: () => void) => {
    if (!notification.readAt) {
      markRead.mutate({ publicIds: [notification.publicId] });
    }
    if (notification.card?.isAvailable) {
      close();
      void router.push(`/cards/${notification.card.publicId}`);
    }
  };

  return (
    <Popover className="relative">
      {({ open }) => (
        <>
          <Popover.Button
            onClick={() => {
              if (!open) void refetch();
            }}
            aria-label={t`Notifications`}
            className={twMerge(
              "flex w-full items-center gap-2 rounded-md p-1.5 text-sm text-neutral-900 hover:bg-light-200 focus:outline-none dark:text-dark-1000 dark:hover:bg-dark-200",
              isCollapsed && "justify-center",
            )}
          >
            <span className="relative">
              <HiOutlineBell className="h-5 w-5" />
              {unreadCount > 0 && (
                <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold leading-none text-white">
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
            </span>
            {!isCollapsed && <span>{t`Notifications`}</span>}
          </Popover.Button>

          <Transition
            as={Fragment}
            enter="transition ease-out duration-100"
            enterFrom="opacity-0 translate-y-1"
            enterTo="opacity-100 translate-y-0"
            leave="transition ease-in duration-75"
            leaveFrom="opacity-100 translate-y-0"
            leaveTo="opacity-0 translate-y-1"
          >
            <Popover.Panel className="absolute bottom-full left-0 z-[100] mb-2 w-[340px] max-w-[calc(100vw-2rem)] rounded-md border border-light-200 bg-white shadow-lg dark:border-dark-400 dark:bg-dark-300">
              {({ close }) => (
                <div className="flex max-h-[70vh] flex-col">
                  <div className="flex items-center justify-between border-b border-light-200 px-3 py-2 dark:border-dark-400">
                    <span className="text-sm font-medium text-neutral-900 dark:text-dark-1000">
                      {t`Notifications`}
                    </span>
                    <button
                      type="button"
                      disabled={unreadCount === 0 || markRead.isPending}
                      onClick={() => markRead.mutate({})}
                      className="text-xs text-light-900 hover:underline disabled:opacity-50 disabled:hover:no-underline dark:text-dark-900"
                    >
                      {t`Mark all as read`}
                    </button>
                  </div>
                  <div className="overflow-y-auto">
                    {isLoading && !notifications ? (
                      <div className="space-y-2 p-3">
                        {[1, 2, 3].map((i) => (
                          <div
                            key={i}
                            className="h-10 w-full animate-pulse rounded bg-light-200 dark:bg-dark-400"
                          />
                        ))}
                      </div>
                    ) : !notifications?.length ? (
                      <p className="px-3 py-8 text-center text-sm text-light-900 dark:text-dark-900">
                        {t`You're all caught up`}
                      </p>
                    ) : (
                      <ul>
                        {notifications.map((notification) => (
                          <li key={notification.publicId}>
                            <button
                              type="button"
                              onClick={() =>
                                openNotification(notification, close)
                              }
                              className="flex w-full gap-2 px-3 py-2 text-left hover:bg-light-200 dark:hover:bg-dark-400"
                            >
                              <span
                                className={twMerge(
                                  "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                                  notification.readAt
                                    ? "bg-transparent"
                                    : "bg-blue-600",
                                )}
                              />
                              <span className="min-w-0">
                                <span className="block text-sm text-neutral-900 dark:text-dark-1000">
                                  {describe(notification)}
                                </span>
                                {notification.type === "card.comment.added" &&
                                  notification.comment && (
                                    <span className="mt-0.5 line-clamp-2 block text-xs text-light-900 dark:text-dark-900">
                                      {stripHtml(notification.comment)}
                                    </span>
                                  )}
                                <span className="mt-0.5 block text-xs text-light-800 dark:text-dark-800">
                                  {[
                                    notification.boardName,
                                    formatDistanceToNow(
                                      notification.createdAt,
                                      {
                                        addSuffix: true,
                                      },
                                    ),
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </span>
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </Popover.Panel>
          </Transition>
        </>
      )}
    </Popover>
  );
}
