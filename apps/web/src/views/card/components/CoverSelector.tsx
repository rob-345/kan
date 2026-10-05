import { t } from "@lingui/core/macro";
import { useState } from "react";
import { HiCheck, HiMiniPlus } from "react-icons/hi2";

import type { CardCoverColour } from "@kan/shared/constants";
import { cardCoverColours } from "@kan/shared/constants";

import { usePopup } from "~/providers/popup";
import { api } from "~/utils/api";
import { invalidateCard } from "~/utils/cardInvalidation";

interface CoverAttachment {
  publicId: string;
  contentType: string;
  url: string | null;
}

export function CoverSelector({
  cardPublicId,
  coverColour,
  coverAttachmentPublicId,
  attachments,
  isLoading = false,
  disabled = false,
}: {
  cardPublicId: string;
  coverColour: string | null | undefined;
  coverAttachmentPublicId: string | null | undefined;
  attachments: CoverAttachment[];
  isLoading?: boolean;
  disabled?: boolean;
}) {
  const utils = api.useUtils();
  const { showPopup } = usePopup();
  const [isOpen, setIsOpen] = useState(false);

  const imageAttachments = attachments.filter(
    (attachment) =>
      attachment.contentType.startsWith("image/") && attachment.url,
  );
  const coverImage = imageAttachments.find(
    (attachment) => attachment.publicId === coverAttachmentPublicId,
  );

  const updateCover = api.card.update.useMutation({
    onMutate: async (update) => {
      await utils.card.byId.cancel({ cardPublicId });
      const previousCard = utils.card.byId.getData({ cardPublicId });
      utils.card.byId.setData({ cardPublicId }, (oldCard) => {
        if (!oldCard) return oldCard;
        if (update.coverColour !== undefined)
          return {
            ...oldCard,
            coverColour: update.coverColour,
            coverAttachmentPublicId: null,
          };
        if (update.coverAttachmentPublicId !== undefined)
          return {
            ...oldCard,
            coverColour: null,
            coverAttachmentPublicId: update.coverAttachmentPublicId,
          };
        return oldCard;
      });
      return { previousCard };
    },
    onError: (_error, _update, context) => {
      utils.card.byId.setData({ cardPublicId }, context?.previousCard);
      showPopup({
        header: t`Unable to update cover`,
        message: t`Please try again later, or contact customer support.`,
        icon: "error",
      });
    },
    onSettled: async () => {
      await invalidateCard(utils, cardPublicId);
      await utils.board.byId.invalidate();
    },
  });

  const setColour = (colour: CardCoverColour | null) =>
    updateCover.mutate({
      cardPublicId,
      coverColour: colour,
      ...(colour === null && { coverAttachmentPublicId: null }),
    });

  return (
    <div className="relative flex w-full items-center text-left">
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={isLoading || disabled}
        className={`flex h-full w-full items-center rounded-[5px] border-[1px] border-light-50 py-1 pl-2 text-left text-xs text-neutral-900 dark:border-dark-50 dark:text-dark-1000 ${disabled ? "cursor-not-allowed opacity-60" : "hover:border-light-300 hover:bg-light-200 dark:hover:border-dark-200 dark:hover:bg-dark-100"}`}
      >
        {coverImage?.url ? (
          <img
            src={coverImage.url}
            alt=""
            className="h-5 w-12 rounded-sm object-cover"
          />
        ) : coverColour ? (
          <span
            className="h-5 w-12 rounded-sm"
            style={{ backgroundColor: coverColour }}
          />
        ) : (
          <>
            <HiMiniPlus size={22} className="pr-2" />
            {t`Add cover`}
          </>
        )}
      </button>
      {isOpen && !disabled && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setIsOpen(false)}
          />
          <div className="absolute -left-8 top-full z-20 mt-2 w-64 rounded-md border border-light-200 bg-light-50 p-3 shadow-lg dark:border-dark-200 dark:bg-dark-100">
            <p className="mb-2 text-xs font-medium text-light-900 dark:text-dark-900">
              {t`Colours`}
            </p>
            <div className="grid grid-cols-5 gap-2">
              {cardCoverColours.map((colour) => (
                <button
                  key={colour}
                  type="button"
                  aria-label={t`Use colour ${colour} as cover`}
                  onClick={() => setColour(colour)}
                  className="flex h-8 items-center justify-center rounded-sm"
                  style={{ backgroundColor: colour }}
                >
                  {coverColour === colour && (
                    <HiCheck className="h-4 w-4 text-white" />
                  )}
                </button>
              ))}
            </div>
            {imageAttachments.length > 0 && (
              <>
                <p className="mb-2 mt-3 text-xs font-medium text-light-900 dark:text-dark-900">
                  {t`Attachments`}
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {imageAttachments.map((attachment) => (
                    <button
                      key={attachment.publicId}
                      type="button"
                      aria-label={t`Use attachment as cover`}
                      onClick={() =>
                        updateCover.mutate({
                          cardPublicId,
                          coverAttachmentPublicId: attachment.publicId,
                        })
                      }
                      className={`overflow-hidden rounded-sm border-2 ${attachment.publicId === coverAttachmentPublicId ? "border-blue-500" : "border-transparent"}`}
                    >
                      <img
                        src={attachment.url ?? ""}
                        alt=""
                        className="h-12 w-full object-cover"
                      />
                    </button>
                  ))}
                </div>
              </>
            )}
            {(coverColour || coverAttachmentPublicId) && (
              <button
                type="button"
                onClick={() => {
                  setColour(null);
                  setIsOpen(false);
                }}
                className="mt-3 w-full rounded-[5px] border border-light-300 py-1 text-xs text-neutral-900 hover:bg-light-200 dark:border-dark-300 dark:text-dark-1000 dark:hover:bg-dark-200"
              >
                {t`Remove cover`}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
