import { useRouter } from "next/router";
import { t } from "@lingui/core/macro";
import { useCallback, useEffect, useRef, useState } from "react";
import { FaGoogleDrive } from "react-icons/fa";
import { HiArrowTopRightOnSquare, HiXMark } from "react-icons/hi2";

import Button from "~/components/Button";
import { useGoogleDrivePicker } from "~/hooks/useGoogleDrivePicker";
import { usePopup } from "~/providers/popup";
import { api } from "~/utils/api";

// Query parameters the Google callback adds when it sends someone back
const OUTCOME_PARAMS = ["googleDrive", "reason"] as const;

const connectErrorMessage = (reason: string) =>
  reason === "denied"
    ? t`Google Drive access wasn't granted, so Kan can't link files.`
    : t`Something went wrong while connecting Google Drive. Please try again.`;

/**
 * A button that links Google Drive files to a card. The first time, it sends
 * the person to Google to allow access to the files they pick, then brings
 * them back here and opens the picker.
 */
export function GoogleDriveButton({ cardPublicId }: { cardPublicId: string }) {
  const router = useRouter();
  const { showPopup } = usePopup();
  const utils = api.useUtils();
  const openPicker = useGoogleDrivePicker();
  const [isBusy, setIsBusy] = useState(false);
  const handledReturn = useRef(false);

  const { data } = api.driveFile.list.useQuery(
    { cardPublicId },
    { enabled: cardPublicId.length >= 12 },
  );

  const pickerConfig = api.driveFile.pickerConfig.useMutation();
  const authorize = api.googleIntegration.getAuthorizationUrl.useMutation();
  const link = api.driveFile.link.useMutation();

  const showError = useCallback(
    (message: string) =>
      showPopup({
        header: t`Couldn't link Google Drive files`,
        message,
        icon: "error",
      }),
    [showPopup],
  );

  const pickAndLink = useCallback(async () => {
    setIsBusy(true);
    try {
      const config = await pickerConfig.mutateAsync();

      if (
        config.status === "connect" ||
        !config.accessToken ||
        !config.developerKey ||
        !config.appId
      ) {
        const { url } = await authorize.mutateAsync({
          purpose: "drive",
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          returnTo: router.asPath,
        });
        window.location.href = url;
        return;
      }

      const fileIds = await openPicker({
        accessToken: config.accessToken,
        developerKey: config.developerKey,
        appId: config.appId,
        title: t`Link files to this card`,
      });
      if (fileIds.length === 0) return;

      const result = await link.mutateAsync({ cardPublicId, fileIds });
      await Promise.all([
        utils.driveFile.list.invalidate({ cardPublicId }),
        utils.card.getActivities.invalidate({ cardPublicId }),
      ]);

      if (result.failed > 0) {
        showError(
          t`${result.failed} of the files you picked couldn't be read from Google Drive.`,
        );
      }
    } catch (error) {
      showError(
        error instanceof Error && error.message
          ? error.message
          : t`Please try again later.`,
      );
    } finally {
      setIsBusy(false);
    }
  }, [
    authorize,
    cardPublicId,
    link,
    openPicker,
    pickerConfig,
    router.asPath,
    showError,
    utils,
  ]);

  // Coming back from Google: report a failure, or carry on to the picker
  useEffect(() => {
    if (!router.isReady || handledReturn.current) return;
    const outcome = router.query.googleDrive;
    if (!outcome) return;
    handledReturn.current = true;

    const query = { ...router.query };
    for (const param of OUTCOME_PARAMS) delete query[param];
    void router.replace({ pathname: router.pathname, query }, undefined, {
      shallow: true,
    });

    if (outcome === "connected") {
      void pickAndLink();
    } else {
      const reason =
        typeof router.query.reason === "string" ? router.query.reason : "";
      showError(connectErrorMessage(reason));
    }
  }, [router, pickAndLink, showError]);

  if (!data?.available) return null;

  return (
    <Button
      type="button"
      variant="ghost"
      aria-label={t`Link files from Google Drive`}
      title={t`Link files from Google Drive`}
      iconLeft={
        <FaGoogleDrive className="h-4 w-4 text-light-950 dark:text-dark-950" />
      }
      isLoading={isBusy}
      disabled={isBusy}
      iconOnly
      size="sm"
      onClick={() => void pickAndLink()}
    />
  );
}

/** The Google Drive files linked to a card. */
export function DriveFileList({
  cardPublicId,
  isReadOnly = false,
}: {
  cardPublicId: string;
  isReadOnly?: boolean;
}) {
  const { showPopup } = usePopup();
  const utils = api.useUtils();

  const { data } = api.driveFile.list.useQuery(
    { cardPublicId },
    { enabled: cardPublicId.length >= 12 },
  );

  const unlink = api.driveFile.unlink.useMutation({
    onMutate: async ({ driveFilePublicId }) => {
      await utils.driveFile.list.cancel({ cardPublicId });
      const previous = utils.driveFile.list.getData({ cardPublicId });
      utils.driveFile.list.setData({ cardPublicId }, (old) =>
        old
          ? {
              ...old,
              files: old.files.filter(
                (file) => file.publicId !== driveFilePublicId,
              ),
            }
          : old,
      );
      return { previous };
    },
    onError: (_error, _args, context) => {
      utils.driveFile.list.setData({ cardPublicId }, context?.previous);
      showPopup({
        header: t`Unable to remove file`,
        message: t`Please try again later, or contact customer support.`,
        icon: "error",
      });
    },
    onSettled: async () => {
      await Promise.all([
        utils.driveFile.list.invalidate({ cardPublicId }),
        utils.card.getActivities.invalidate({ cardPublicId }),
      ]);
    },
  });

  const files = data?.files ?? [];
  if (files.length === 0) return null;

  return (
    <div className="mt-6 flex flex-col gap-2">
      {files.map((file) => (
        <div
          key={file.publicId}
          className="group flex w-full items-center gap-3 rounded-lg border border-light-300 bg-light-50 px-3 py-2 dark:border-dark-200 dark:bg-dark-100"
        >
          <div className="flex-shrink-0">
            {file.iconUrl ? (
              // Drive's own file-type icon, served by Google
              // eslint-disable-next-line @next/next/no-img-element
              <img src={file.iconUrl} alt="" className="h-4 w-4" />
            ) : (
              <FaGoogleDrive className="h-4 w-4 text-light-700 dark:text-dark-700" />
            )}
          </div>
          <a
            href={file.url}
            target="_blank"
            rel="noopener noreferrer"
            className="min-w-0 flex-1 truncate text-sm text-light-1000 hover:underline dark:text-dark-1000"
            title={file.name}
          >
            {file.name}
          </a>
          <div className="flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100">
            {file.createdByName && (
              <div className="hidden text-xs text-light-500 dark:text-dark-900 sm:block">
                {t`Added by ${file.createdByName}`}
              </div>
            )}
            <a
              href={file.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-shrink-0 rounded-full bg-light-100 p-1.5 text-light-1000 transition-colors hover:bg-light-200 focus:outline-none dark:bg-dark-100 dark:text-dark-950 dark:hover:bg-dark-300"
              aria-label={t`Open ${file.name} in Google Drive`}
            >
              <HiArrowTopRightOnSquare className="h-4 w-4" />
            </a>
            {!isReadOnly && (
              <button
                type="button"
                onClick={() =>
                  unlink.mutate({ driveFilePublicId: file.publicId })
                }
                className="flex-shrink-0 rounded-full bg-light-100 p-1.5 text-light-1000 transition-colors hover:bg-light-200 focus:outline-none dark:bg-dark-100 dark:text-dark-950 dark:hover:bg-dark-300"
                aria-label={t`Remove ${file.name} from this card`}
              >
                <HiXMark className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
