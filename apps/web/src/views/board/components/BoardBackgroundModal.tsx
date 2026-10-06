import { t } from "@lingui/core/macro";
import { env } from "next-runtime-env";
import { useRef, useState } from "react";
import { HiCheck, HiOutlinePhoto, HiXMark } from "react-icons/hi2";

import type {
  BoardBackgroundColour,
  BoardBackgroundGradient,
} from "@kan/shared/constants";
import {
  BOARD_BACKGROUND_MAX_BYTES,
  boardBackgroundColours,
  boardBackgroundGradients,
  boardBackgroundPhotos,
} from "@kan/shared/constants";

import type { RouterInputs } from "~/utils/api";
import Button from "~/components/Button";
import Input from "~/components/Input";
import { useModal } from "~/providers/modal";
import { usePopup } from "~/providers/popup";
import { api } from "~/utils/api";

type BoardQueryParams = RouterInputs["board"]["byId"];

const ALLOWED_UPLOAD_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

export function BoardBackgroundModal({
  queryParams,
}: {
  queryParams: BoardQueryParams;
}) {
  const { closeModal } = useModal();
  const { showPopup } = usePopup();
  const utils = api.useUtils();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [customUrl, setCustomUrl] = useState("");
  const [uploading, setUploading] = useState(false);

  const boardPublicId = queryParams.boardPublicId;
  const board = utils.board.byId.getData(queryParams);
  const currentColour = board?.backgroundColour ?? null;
  const currentImage = board?.backgroundImageUrl ?? null;
  const canUpload = !!env("NEXT_PUBLIC_ATTACHMENTS_BUCKET_NAME");

  const photoLabels: Record<
    (typeof boardBackgroundPhotos)[number]["key"],
    string
  > = {
    mountains: t`Mountains`,
    waves: t`Waves`,
    aurora: t`Aurora`,
    dunes: t`Dunes`,
    hills: t`Hills`,
    bubbles: t`Bubbles`,
  };

  const invalidateBoards = async () => {
    await Promise.all([
      utils.board.byId.invalidate(),
      utils.board.all.invalidate(),
    ]);
  };

  const showError = () =>
    showPopup({
      header: t`Unable to change background`,
      message: t`Please try again later, or contact customer support.`,
      icon: "error",
    });

  const updateBackground = api.board.update.useMutation({
    onMutate: async (update) => {
      await utils.board.byId.cancel(queryParams);
      const previousBoard = utils.board.byId.getData(queryParams);
      utils.board.byId.setData(queryParams, (oldBoard) => {
        if (!oldBoard) return oldBoard;
        return {
          ...oldBoard,
          backgroundColour: update.backgroundColour ?? null,
          backgroundImageUrl: update.backgroundImage ?? null,
        };
      });
      return { previousBoard };
    },
    onError: (_error, _update, context) => {
      utils.board.byId.setData(queryParams, context?.previousBoard);
      showError();
    },
    onSettled: invalidateBoards,
  });

  const setColour = (
    colour: BoardBackgroundColour | BoardBackgroundGradient | null,
  ) => updateBackground.mutate({ boardPublicId, backgroundColour: colour });

  const setImage = (image: string | null) =>
    updateBackground.mutate({ boardPublicId, backgroundImage: image });

  const isValidCustomUrl = (() => {
    try {
      return new URL(customUrl).protocol === "https:";
    } catch {
      return false;
    }
  })();

  const uploadFile = async (file: File) => {
    if (!ALLOWED_UPLOAD_TYPES.includes(file.type)) {
      showPopup({
        header: t`Unsupported file`,
        message: t`Choose a JPEG, PNG, WebP or GIF image.`,
        icon: "error",
      });
      return;
    }
    if (file.size > BOARD_BACKGROUND_MAX_BYTES) {
      showPopup({
        header: t`File too large`,
        message: t`Background images can be up to 10 MB.`,
        icon: "error",
      });
      return;
    }

    setUploading(true);
    try {
      const baseUrl = env("NEXT_PUBLIC_BASE_URL") ?? "";
      const response = await fetch(
        `${baseUrl}/api/upload/board-background?boardPublicId=${encodeURIComponent(boardPublicId)}`,
        {
          method: "POST",
          headers: { "Content-Type": file.type },
          body: file,
        },
      );
      if (!response.ok) throw new Error("Upload failed");
      await invalidateBoards();
    } catch {
      showError();
    } finally {
      setUploading(false);
    }
  };

  const swatchClass = (selected: boolean) =>
    `relative flex h-14 items-center justify-center overflow-hidden rounded-md border-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${selected ? "border-blue-500" : "border-transparent hover:opacity-90"}`;

  const sectionHeading =
    "mb-2 mt-4 text-xs font-medium text-light-900 dark:text-dark-900";

  return (
    <div className="px-5 pb-5 pt-5">
      <div className="flex w-full items-center justify-between pb-2">
        <h2 className="text-sm font-bold text-neutral-900 dark:text-dark-1000">
          {t`Change background`}
        </h2>
        <button
          type="button"
          aria-label={t`Close`}
          className="rounded p-1 hover:bg-light-200 focus:outline-none dark:hover:bg-dark-300"
          onClick={() => closeModal()}
        >
          <HiXMark size={18} className="text-light-900 dark:text-dark-900" />
        </button>
      </div>

      <p className={sectionHeading}>{t`Photos`}</p>
      <div className="grid grid-cols-3 gap-2">
        {boardBackgroundPhotos.map((photo) => (
          <button
            key={photo.key}
            type="button"
            aria-label={t`Use ${photoLabels[photo.key]} background`}
            title={photoLabels[photo.key]}
            onClick={() => setImage(photo.path)}
            className={swatchClass(currentImage === photo.path)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo.path}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
            />
            {currentImage === photo.path && (
              <HiCheck className="relative h-5 w-5 text-white drop-shadow" />
            )}
          </button>
        ))}
      </div>

      <p className={sectionHeading}>{t`Gradients`}</p>
      <div className="grid grid-cols-4 gap-2">
        {(
          Object.entries(boardBackgroundGradients) as [
            BoardBackgroundGradient,
            string,
          ][]
        ).map(([key, css]) => (
          <button
            key={key}
            type="button"
            aria-label={t`Use gradient background`}
            onClick={() => setColour(key)}
            className={swatchClass(currentColour === key)}
            style={{ background: css }}
          >
            {currentColour === key && (
              <HiCheck className="h-5 w-5 text-white drop-shadow" />
            )}
          </button>
        ))}
      </div>

      <p className={sectionHeading}>{t`Colours`}</p>
      <div className="grid grid-cols-5 gap-2">
        {boardBackgroundColours.map((colour) => (
          <button
            key={colour}
            type="button"
            aria-label={t`Use colour ${colour} as background`}
            onClick={() => setColour(colour)}
            className={`${swatchClass(currentColour === colour)} !h-10`}
            style={{ backgroundColor: colour }}
          >
            {currentColour === colour && (
              <HiCheck className="h-5 w-5 text-white" />
            )}
          </button>
        ))}
      </div>

      <p className={sectionHeading}>{t`Custom image`}</p>
      <form
        className="flex items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!isValidCustomUrl) return;
          setImage(customUrl);
          setCustomUrl("");
        }}
      >
        <div className="flex-1">
          <Input
            id="board-background-url"
            placeholder={t`Paste an https image link`}
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
            errorMessage={
              customUrl && !isValidCustomUrl
                ? t`Use a full link starting with https://`
                : undefined
            }
          />
        </div>
        <Button
          type="submit"
          variant="secondary"
          disabled={!isValidCustomUrl || updateBackground.isPending}
        >
          {t`Use link`}
        </Button>
      </form>

      {canUpload && (
        <>
          <input
            ref={inputRef}
            type="file"
            accept={ALLOWED_UPLOAD_TYPES.join(",")}
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) await uploadFile(file);
            }}
          />
          <div className="mt-2">
            <Button
              variant="secondary"
              fullWidth
              isLoading={uploading}
              disabled={uploading}
              onClick={() => inputRef.current?.click()}
              iconLeft={<HiOutlinePhoto className="h-4 w-4" />}
            >
              {t`Upload an image`}
            </Button>
          </div>
        </>
      )}

      {(currentColour ?? currentImage) && (
        <button
          type="button"
          onClick={() => setColour(null)}
          className="mt-4 w-full rounded-[5px] border border-light-300 py-1.5 text-xs text-neutral-900 hover:bg-light-200 dark:border-dark-300 dark:text-dark-1000 dark:hover:bg-dark-200"
        >
          {t`Remove background`}
        </button>
      )}
    </div>
  );
}
