import { getBoardBackgroundCss } from "@kan/shared/constants";

import PatternedBackground from "~/components/PatternedBackground";

export const hasBoardBackground = (board?: {
  backgroundColour?: string | null;
  backgroundImageUrl?: string | null;
}) =>
  !!(
    board?.backgroundImageUrl ?? getBoardBackgroundCss(board?.backgroundColour)
  );

/**
 * Fills its positioned parent with a board's chosen colour, gradient or
 * image, falling back to the default dotted pattern. The parent needs
 * `isolate` so the layer sits behind the parent's other content.
 */
export default function BoardBackground({
  colour,
  imageUrl,
  dimTop = false,
}: {
  colour: string | null | undefined;
  imageUrl: string | null | undefined;
  /** Darkens the top edge so white header text stays readable. */
  dimTop?: boolean;
}) {
  const backgroundCss = getBoardBackgroundCss(colour);

  if (!imageUrl && !backgroundCss) return <PatternedBackground />;

  return (
    <div
      className="absolute inset-0 -z-10 h-full w-full overflow-hidden"
      style={backgroundCss ? { background: backgroundCss } : undefined}
    >
      {imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
        />
      )}
      {dimTop && (
        <div className="absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-black/40 to-transparent" />
      )}
    </div>
  );
}
