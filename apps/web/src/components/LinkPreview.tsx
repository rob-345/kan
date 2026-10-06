import { t } from "@lingui/core/macro";
import { useMemo, useState } from "react";
import { HiOutlineLink } from "react-icons/hi2";
import { twMerge } from "tailwind-merge";

import type { RouterOutputs } from "~/utils/api";
import { api } from "~/utils/api";
import { linkifyHtml } from "~/utils/linkify";

type LinkPreviewData = NonNullable<RouterOutputs["link"]["preview"]>;

const PREVIEW_STALE_TIME = 60 * 60 * 1000;
const MAX_INLINE_PREVIEWS = 3;

const hostnameOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const isHttpUrl = (value: string) => /^https?:\/\//i.test(value);

/** Loads the preview for a URL from the server (which caches it). */
export const useLinkPreview = (url: string, enabled = true) =>
  api.link.preview.useQuery(
    { url },
    {
      enabled: enabled && isHttpUrl(url),
      staleTime: PREVIEW_STALE_TIME,
      retry: false,
      refetchOnWindowFocus: false,
    },
  );

/**
 * A rich card for a web link: page image, title, description and site,
 * falling back to the plain address when no metadata is available.
 */
export function LinkPreviewCard({
  url,
  title,
  preview,
  isLoading = false,
  compact = false,
  actions,
}: {
  url: string;
  title?: string | null;
  preview: LinkPreviewData | null | undefined;
  isLoading?: boolean;
  compact?: boolean;
  actions?: React.ReactNode;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const [faviconFailed, setFaviconFailed] = useState(false);

  const hasMetadata = preview?.status === "ok";
  const href = url;
  const host = hostnameOf(preview?.finalUrl ?? url);
  const heading = title ?? (hasMetadata ? preview.title : null) ?? url;
  const description = hasMetadata ? preview.description : null;
  const imageUrl = hasMetadata && !imageFailed ? preview.imageUrl : null;
  const faviconUrl = hasMetadata && !faviconFailed ? preview.faviconUrl : null;
  const siteName = (hasMetadata ? preview.siteName : null) ?? host;

  return (
    <div className="group relative">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className={twMerge(
          "flex w-full overflow-hidden rounded-lg border border-light-300 bg-light-50 text-left transition-colors hover:bg-light-100 dark:border-dark-400 dark:bg-dark-100 dark:hover:bg-dark-200",
          compact ? "max-w-xl" : "",
        )}
      >
        {isLoading ? (
          <div
            className={twMerge(
              "shrink-0 animate-pulse bg-light-200 dark:bg-dark-300",
              compact ? "h-[72px] w-[96px]" : "h-[88px] w-[128px]",
            )}
          />
        ) : imageUrl ? (
          // External images are shown as-is; next/image would need every
          // host allow-listed.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setImageFailed(true)}
            className={twMerge(
              "shrink-0 bg-light-200 object-cover dark:bg-dark-300",
              compact ? "h-[72px] w-[96px]" : "h-[88px] w-[128px]",
            )}
          />
        ) : (
          <div
            className={twMerge(
              "flex shrink-0 items-center justify-center bg-light-200 dark:bg-dark-300",
              compact ? "h-[72px] w-[72px]" : "h-[88px] w-[88px]",
            )}
          >
            <HiOutlineLink className="h-6 w-6 text-light-900 dark:text-dark-900" />
          </div>
        )}
        <div
          className={twMerge(
            "flex min-w-0 flex-1 flex-col justify-center px-3 py-2",
            actions ? "pr-10" : "",
          )}
        >
          {isLoading ? (
            <>
              <div className="h-3 w-24 animate-pulse rounded bg-light-200 dark:bg-dark-300" />
              <div className="mt-2 h-4 w-3/4 animate-pulse rounded bg-light-200 dark:bg-dark-300" />
              <div className="mt-2 h-3 w-1/2 animate-pulse rounded bg-light-200 dark:bg-dark-300" />
            </>
          ) : (
            <>
              <div className="flex min-w-0 items-center gap-1.5 text-xs text-light-900 dark:text-dark-900">
                {faviconUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={faviconUrl}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    onError={() => setFaviconFailed(true)}
                    className="h-3.5 w-3.5 shrink-0 rounded-sm"
                  />
                )}
                <span className="truncate">{siteName}</span>
              </div>
              <p className="mt-0.5 line-clamp-1 break-all text-sm font-medium text-light-1000 dark:text-dark-1000">
                {heading}
              </p>
              {description && (
                <p
                  className={twMerge(
                    "mt-0.5 text-xs text-light-900 dark:text-dark-900",
                    compact ? "line-clamp-1" : "line-clamp-2",
                  )}
                >
                  {description}
                </p>
              )}
            </>
          )}
        </div>
      </a>
      {actions && <div className="absolute right-2 top-2">{actions}</div>}
    </div>
  );
}

/** A preview card that fetches its own metadata. */
export function LinkPreview({
  url,
  title,
  compact,
  actions,
}: {
  url: string;
  title?: string | null;
  compact?: boolean;
  actions?: React.ReactNode;
}) {
  const { data, isLoading } = useLinkPreview(url);

  return (
    <LinkPreviewCard
      url={url}
      title={title}
      preview={data}
      isLoading={isLoading}
      compact={compact}
      actions={actions}
    />
  );
}

/** Returns the distinct http(s) link targets in a piece of editor HTML. */
export const extractLinks = (html: string | null | undefined): string[] => {
  if (!html || typeof window === "undefined") return [];
  const doc = new DOMParser().parseFromString(linkifyHtml(html), "text/html");
  const urls: string[] = [];
  for (const anchor of Array.from(doc.querySelectorAll("a[href]"))) {
    const href = anchor.getAttribute("href")?.trim() ?? "";
    if (!isHttpUrl(href)) continue;
    // Embedded YouTube videos already show their own player.
    if (anchor.closest("[data-youtube]")) continue;
    if (!urls.includes(href)) urls.push(href);
  }
  return urls;
};

/**
 * Preview cards for the links inside a description or comment. Only links
 * that have page metadata get a card; the rest stay as plain links in the
 * text.
 */
export function InlineLinkPreviews({
  html,
  className,
}: {
  html: string | null | undefined;
  className?: string;
}) {
  const urls = useMemo(
    () => extractLinks(html).slice(0, MAX_INLINE_PREVIEWS),
    [html],
  );

  if (urls.length === 0) return null;

  return (
    <div
      className={twMerge("flex flex-col gap-2", className)}
      aria-label={t`Link previews`}
    >
      {urls.map((url) => (
        <InlineLinkPreview key={url} url={url} />
      ))}
    </div>
  );
}

function InlineLinkPreview({ url }: { url: string }) {
  const { data } = useLinkPreview(url);
  if (
    data?.status !== "ok" ||
    (!data.title && !data.description && !data.imageUrl)
  ) {
    return null;
  }
  return <LinkPreviewCard url={url} preview={data} compact />;
}
