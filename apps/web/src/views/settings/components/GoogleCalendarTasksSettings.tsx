import { useRouter } from "next/router";
import { t } from "@lingui/core/macro";
import { useEffect } from "react";
import { HiMiniArrowTopRightOnSquare } from "react-icons/hi2";

import Button from "~/components/Button";
import { usePopup } from "~/providers/popup";
import { api } from "~/utils/api";

const connectErrorMessage = (reason: string) => {
  switch (reason) {
    case "denied":
      return t`Google access wasn't granted. Allow Calendar or Tasks access to connect.`;
    case "invalid_state":
      return t`The connection link expired. Please try again.`;
    case "no_refresh_token":
      return t`Google didn't allow ongoing access. Please try again.`;
    default:
      return t`Something went wrong while connecting Google. Please try again.`;
  }
};

const browserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

/**
 * Lets a person connect their Google account so the cards they're a member of
 * show up in a "Kan" calendar and a "Kan" task list.
 */
export default function GoogleCalendarTasksSettings() {
  const router = useRouter();
  const { showPopup } = usePopup();
  const utils = api.useUtils();

  const { data: status, isLoading } = api.googleIntegration.status.useQuery();

  // Report the outcome of the Google consent screen once, then tidy the URL
  useEffect(() => {
    const outcome = router.query.google;
    if (!outcome) return;

    if (outcome === "connected") {
      showPopup({
        header: t`Google connected`,
        message: t`Your cards will appear in Google Calendar and Tasks shortly.`,
        icon: "success",
      });
    } else {
      const reason =
        typeof router.query.reason === "string" ? router.query.reason : "";
      showPopup({
        header: t`Couldn't connect Google`,
        message: connectErrorMessage(reason),
        icon: "error",
      });
    }
    void router.replace("/settings/account", undefined, { shallow: true });
  }, [router, showPopup]);

  const connect = api.googleIntegration.getAuthorizationUrl.useMutation({
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (error) => {
      showPopup({
        header: t`Couldn't connect Google`,
        message: error.message,
        icon: "error",
      });
    },
  });

  const update = api.googleIntegration.update.useMutation({
    onSuccess: () => utils.googleIntegration.status.invalidate(),
    onError: (error) => {
      showPopup({
        header: t`Couldn't update Google sync`,
        message: error.message,
        icon: "error",
      });
    },
  });

  const disconnect = api.googleIntegration.disconnect.useMutation({
    onSuccess: () => {
      void utils.googleIntegration.status.invalidate();
      showPopup({
        header: t`Google disconnected`,
        message: t`The Kan calendar and task list were removed from your Google account.`,
        icon: "success",
      });
    },
    onError: (error) => {
      showPopup({
        header: t`Couldn't disconnect Google`,
        message: error.message,
        icon: "error",
      });
    },
  });

  if (isLoading || !status?.configured) return null;

  const connectButton = (label: string) => (
    <Button
      variant="primary"
      iconRight={<HiMiniArrowTopRightOnSquare />}
      isLoading={connect.isPending}
      onClick={() => connect.mutate({ timeZone: browserTimeZone() })}
    >
      {label}
    </Button>
  );

  return (
    <div className="mb-8 border-t border-light-300 dark:border-dark-300">
      <h2 className="mb-4 mt-8 text-[14px] font-bold text-neutral-900 dark:text-dark-1000">
        {t`Google Calendar and Tasks`}
      </h2>

      {!status.connected ? (
        <>
          <p className="mb-8 text-sm text-neutral-500 dark:text-dark-900">
            {t`Show the cards you're a member of in your own Google account: a "Kan" calendar with an event at each due time (with your card's reminder), and a "Kan" list in Google Tasks. Kan can only see the calendar and task list it creates.`}
          </p>
          {connectButton(t`Connect Google`)}
        </>
      ) : (
        <>
          <p className="mb-4 text-sm text-neutral-500 dark:text-dark-900">
            {status.googleEmail
              ? t`Connected as ${status.googleEmail}.`
              : t`Google is connected.`}
          </p>

          {status.needsReconnect && (
            <div className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
              <p className="mb-3 text-sm text-amber-700 dark:text-amber-300">
                {t`Kan lost access to your Google account, so syncing has stopped. Reconnect to resume.`}
              </p>
              {connectButton(t`Reconnect Google`)}
            </div>
          )}

          <div className="mb-6 space-y-3">
            <label className="flex cursor-pointer items-start space-x-2">
              <input
                type="checkbox"
                checked={status.calendarEnabled}
                disabled={!status.calendarGranted || update.isPending}
                onChange={(e) =>
                  update.mutate({ calendarEnabled: e.target.checked })
                }
                className="text-primary-600 focus:ring-primary-500 mt-0.5 h-4 w-4 rounded border-light-400 dark:border-dark-400"
              />
              <span className="text-sm text-light-900 dark:text-dark-900">
                {t`Google Calendar: add due dates to a "Kan" calendar`}
                {!status.calendarGranted && (
                  <span className="block text-xs text-neutral-500 dark:text-dark-800">
                    {t`Calendar access wasn't granted. Reconnect to allow it.`}
                  </span>
                )}
              </span>
            </label>
            <label className="flex cursor-pointer items-start space-x-2">
              <input
                type="checkbox"
                checked={status.tasksEnabled}
                disabled={!status.tasksGranted || update.isPending}
                onChange={(e) =>
                  update.mutate({ tasksEnabled: e.target.checked })
                }
                className="text-primary-600 focus:ring-primary-500 mt-0.5 h-4 w-4 rounded border-light-400 dark:border-dark-400"
              />
              <span className="text-sm text-light-900 dark:text-dark-900">
                {t`Google Tasks: add cards to a "Kan" task list`}
                <span className="block text-xs text-neutral-500 dark:text-dark-800">
                  {status.tasksGranted
                    ? t`Google Tasks only keeps the due date, not the time.`
                    : t`Tasks access wasn't granted. Reconnect to allow it.`}
                </span>
              </span>
            </label>
          </div>

          <div className="flex gap-2">
            {!status.needsReconnect &&
              (!status.calendarGranted || !status.tasksGranted) &&
              connectButton(t`Reconnect Google`)}
            <Button
              variant="secondary"
              isLoading={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              {t`Disconnect Google`}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
