import type { dbClient } from "@kan/db/client";
import type { LinkPreviewInput } from "@kan/db/repository/linkPreview.repo";
import * as linkPreviewRepo from "@kan/db/repository/linkPreview.repo";
import { createLogger } from "@kan/logger";

import type { FetchPageOptions } from "./fetch";
import { fetchPage } from "./fetch";
import { findMetaCharset, parseMetadata, resolveHttpUrl } from "./parse";

export { LinkPreviewFetchError } from "./fetch";

const log = createLogger("link-preview");

const MAX_LINK_LENGTH = 2048;
// Successful previews are reused for a week; failures are retried sooner.
const OK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FAILED_TTL_MS = 60 * 60 * 1000;

export interface LinkPreview {
  url: string;
  status: "ok" | "failed";
  finalUrl: string | null;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  faviconUrl: string | null;
}

/**
 * Normalises what a user typed or pasted into an absolute http(s) URL, adding
 * https:// when no scheme was given. Returns null for anything else.
 */
export const normalizeLinkUrl = (input: string): string | null => {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > MAX_LINK_LENGTH) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if (!url.hostname.includes(".") && !url.hostname.startsWith("[")) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
};

/** The cache key for a link: the URL without its #fragment. */
const cacheKeyFor = (url: string) => {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.toString();
};

const filenameFromUrl = (url: string): string | null => {
  try {
    const segment = new URL(url).pathname.split("/").filter(Boolean).pop();
    return segment ? decodeURIComponent(segment) : null;
  } catch {
    return null;
  }
};

const decodeBody = (body: Buffer, contentType: string): string => {
  const headerCharset = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim();
  const sniffed = findMetaCharset(body.subarray(0, 4096).toString("latin1"));
  const charset = headerCharset ?? sniffed ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
};

/** Fetches a page and turns it into preview metadata (no caching). */
export const buildLinkPreview = async (
  url: string,
  fetchOptions?: FetchPageOptions,
): Promise<LinkPreviewInput> => {
  const key = cacheKeyFor(url);
  try {
    const page = await fetchPage(key, fetchOptions);
    const host = new URL(page.finalUrl).hostname.replace(/^www\./, "");

    if (page.contentType.startsWith("image/")) {
      return {
        url: key,
        status: "ok",
        finalUrl: page.finalUrl,
        title: filenameFromUrl(page.finalUrl),
        description: null,
        imageUrl: page.finalUrl,
        siteName: host,
        faviconUrl: resolveHttpUrl("/favicon.ico", page.finalUrl),
      };
    }

    if (page.body.length === 0) {
      return {
        url: key,
        status: "ok",
        finalUrl: page.finalUrl,
        title: filenameFromUrl(page.finalUrl),
        description: null,
        imageUrl: null,
        siteName: host,
        faviconUrl: resolveHttpUrl("/favicon.ico", page.finalUrl),
      };
    }

    const html = decodeBody(page.body, page.contentType);
    const metadata = parseMetadata(html, page.finalUrl);
    return {
      url: key,
      status: "ok",
      finalUrl: page.finalUrl,
      ...metadata,
      siteName: metadata.siteName ?? host,
    };
  } catch (error) {
    log.debug({ url: key, error: String(error) }, "Link preview fetch failed");
    return {
      url: key,
      status: "failed",
      finalUrl: null,
      title: null,
      description: null,
      imageUrl: null,
      siteName: null,
      faviconUrl: null,
    };
  }
};

const isFresh = (preview: { status: string; fetchedAt: Date }) =>
  Date.now() - preview.fetchedAt.getTime() <
  (preview.status === "ok" ? OK_TTL_MS : FAILED_TTL_MS);

const toLinkPreview = (row: LinkPreviewInput): LinkPreview => ({
  url: row.url,
  status: row.status,
  finalUrl: row.finalUrl,
  title: row.title,
  description: row.description,
  imageUrl: row.imageUrl,
  siteName: row.siteName,
  faviconUrl: row.faviconUrl,
});

// Concurrent requests for the same URL share one fetch.
const inFlight = new Map<string, Promise<LinkPreview>>();

/**
 * Returns the preview for a URL from the cache, fetching it when it is
 * missing or stale. With `cachedOnly`, never fetches (returns a stale or
 * missing preview as is).
 */
export const getLinkPreview = async (
  db: dbClient,
  url: string,
  options: {
    force?: boolean;
    cachedOnly?: boolean;
    /** Called before a network fetch; returning false skips the fetch. */
    canFetch?: () => Promise<boolean>;
  } = {},
): Promise<LinkPreview | null> => {
  const key = cacheKeyFor(url);

  const cached = await linkPreviewRepo.getByUrl(db, key);
  if (cached && !options.force && (isFresh(cached) || options.cachedOnly)) {
    return toLinkPreview(cached);
  }
  if (options.cachedOnly) return null;

  const pending = inFlight.get(key);
  if (pending) return pending;

  if (options.canFetch && !(await options.canFetch())) {
    return cached ? toLinkPreview(cached) : null;
  }

  const work = (async () => {
    const preview = await buildLinkPreview(key);
    try {
      await linkPreviewRepo.upsert(db, preview);
    } catch (error) {
      log.warn({ url: key, error: String(error) }, "Could not cache preview");
    }
    return toLinkPreview(preview);
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, work);
  return work;
};
