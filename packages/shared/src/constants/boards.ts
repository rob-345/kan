/** Solid colours a board background can use. */
export const boardBackgroundColours = [
  "#0079bf",
  "#d29034",
  "#519839",
  "#b04632",
  "#89609e",
  "#cd5a91",
  "#4bbf6b",
  "#00aecc",
  "#838c91",
  "#1e293b",
] as const;

export type BoardBackgroundColour = (typeof boardBackgroundColours)[number];

/**
 * Gradients a board background can use. Boards store the key, never the
 * CSS, so arbitrary styles can't be injected through the API.
 */
export const boardBackgroundGradients = {
  "gradient-ocean": "linear-gradient(135deg, #0c66e4 0%, #37b4c3 100%)",
  "gradient-sunset": "linear-gradient(135deg, #f87168 0%, #fca700 100%)",
  "gradient-aurora":
    "linear-gradient(135deg, #1d7afc 0%, #8f7ee7 50%, #e774bb 100%)",
  "gradient-forest": "linear-gradient(135deg, #1f845a 0%, #94c748 100%)",
  "gradient-dusk": "linear-gradient(135deg, #352c63 0%, #ae4787 100%)",
  "gradient-ember": "linear-gradient(135deg, #c9372c 0%, #fea362 100%)",
  "gradient-midnight": "linear-gradient(135deg, #0f172a 0%, #334155 100%)",
  "gradient-peach": "linear-gradient(135deg, #f9c6d0 0%, #fbd38d 100%)",
} as const;

export type BoardBackgroundGradient = keyof typeof boardBackgroundGradients;

export const boardBackgroundColourValues = [
  ...boardBackgroundColours,
  ...(Object.keys(boardBackgroundGradients) as BoardBackgroundGradient[]),
] as const;

/** Bundled background pictures, served from apps/web/public. */
export const boardBackgroundPhotos = [
  { key: "mountains", path: "/backgrounds/mountains.svg" },
  { key: "waves", path: "/backgrounds/waves.svg" },
  { key: "aurora", path: "/backgrounds/aurora.svg" },
  { key: "dunes", path: "/backgrounds/dunes.svg" },
  { key: "hills", path: "/backgrounds/hills.svg" },
  { key: "bubbles", path: "/backgrounds/bubbles.svg" },
] as const;

export const boardBackgroundPhotoPaths: readonly string[] =
  boardBackgroundPhotos.map((photo) => photo.path);

/** Uploaded board backgrounds are stored under this S3 key prefix. */
export const BOARD_BACKGROUND_KEY_PREFIX = "board-backgrounds/";

/** Largest board background image that can be uploaded. */
export const BOARD_BACKGROUND_MAX_BYTES = 10 * 1024 * 1024;

/** Resolves a stored colour value to CSS for the `background` property. */
export const getBoardBackgroundCss = (
  colour: string | null | undefined,
): string | undefined => {
  if (!colour) return undefined;
  if (colour in boardBackgroundGradients)
    return boardBackgroundGradients[colour as BoardBackgroundGradient];
  if ((boardBackgroundColours as readonly string[]).includes(colour))
    return colour;
  return undefined;
};
