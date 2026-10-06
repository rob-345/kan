import { createLogger } from "@kan/logger";
import { BOARD_BACKGROUND_KEY_PREFIX } from "@kan/shared/constants";
import { deleteObject, generateBoardBackgroundUrl } from "@kan/shared/utils";

const log = createLogger("board-background");

/** Swaps a board's stored background image for a URL the browser can load. */
export const withBackgroundImageUrl = async <
  T extends { backgroundImage: string | null },
>({
  backgroundImage,
  ...board
}: T): Promise<
  Omit<T, "backgroundImage"> & { backgroundImageUrl: string | null }
> => ({
  ...board,
  backgroundImageUrl: await generateBoardBackgroundUrl(backgroundImage),
});

/** Removes a replaced background image from storage if it was an upload. */
export const deleteUploadedBoardBackground = async (
  backgroundImage: string | null | undefined,
) => {
  const bucket = process.env.NEXT_PUBLIC_ATTACHMENTS_BUCKET_NAME;
  if (!bucket || !backgroundImage?.startsWith(BOARD_BACKGROUND_KEY_PREFIX))
    return;
  try {
    await deleteObject(bucket, backgroundImage);
  } catch (error) {
    log.warn({ error }, "Failed to delete replaced board background");
  }
};
