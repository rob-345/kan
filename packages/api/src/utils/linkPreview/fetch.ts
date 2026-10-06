import { lookup as dnsLookup } from "dns";
import http from "http";
import https from "https";
import zlib from "zlib";
import type { IncomingMessage } from "http";
import type { LookupFunction } from "net";
import type { Readable } from "stream";

import { ALLOWED_PORTS, isBlockedAddress, isBlockedHostname } from "./address";

export class LinkPreviewFetchError extends Error {}

export interface FetchedPage {
  finalUrl: string;
  contentType: string;
  body: Buffer;
}

export interface FetchPageOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Only for tests that serve pages from localhost. */
  allowPrivateAddresses?: boolean;
}

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;

const USER_AGENT =
  "Mozilla/5.0 (compatible; KanLinkPreview/1.0; +https://kan.bn)";

/**
 * Checks every address a hostname resolves to at connection time, so a DNS
 * answer that changes between validation and connection (DNS rebinding) or a
 * redirect to an internal host is still refused.
 */
const createSafeLookup =
  (allowPrivateAddresses: boolean): LookupFunction =>
  (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, "", 0);
        return;
      }
      const list = Array.isArray(addresses) ? addresses : [];
      if (list.length === 0) {
        callback(new LinkPreviewFetchError("Host did not resolve"), "", 0);
        return;
      }
      if (
        !allowPrivateAddresses &&
        list.some((entry) => isBlockedAddress(entry.address))
      ) {
        callback(
          new LinkPreviewFetchError("Host resolves to a private address"),
          "",
          0,
        );
        return;
      }
      if (options.all) {
        callback(null, list);
      } else {
        const [first] = list;
        callback(null, first?.address ?? "", first?.family ?? 4);
      }
    });
  };

/** Validates a URL before it is requested (including redirect targets). */
export const assertFetchableUrl = (
  value: string,
  allowPrivateAddresses = false,
): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LinkPreviewFetchError("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LinkPreviewFetchError("Only http and https links are supported");
  }
  if (url.username || url.password) {
    throw new LinkPreviewFetchError("Links with credentials are not supported");
  }
  if (!allowPrivateAddresses) {
    if (!ALLOWED_PORTS.has(url.port)) {
      throw new LinkPreviewFetchError("Port not allowed");
    }
    if (isBlockedHostname(url.hostname)) {
      throw new LinkPreviewFetchError("Host not allowed");
    }
  }
  return url;
};

const decompress = (response: IncomingMessage): Readable => {
  const encoding = (response.headers["content-encoding"] ?? "")
    .toString()
    .trim()
    .toLowerCase();
  if (encoding === "gzip" || encoding === "x-gzip") {
    return response.pipe(zlib.createGunzip());
  }
  if (encoding === "deflate") return response.pipe(zlib.createInflate());
  if (encoding === "br") return response.pipe(zlib.createBrotliDecompress());
  return response;
};

const requestOnce = (
  url: URL,
  options: Required<Omit<FetchPageOptions, "maxRedirects">>,
  deadline: number,
): Promise<
  | { kind: "redirect"; location: string }
  | { kind: "page"; contentType: string; body: Buffer }
> =>
  new Promise((resolvePromise, rejectPromise) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      rejectPromise(new LinkPreviewFetchError("Timed out"));
      return;
    }

    // A hard deadline for the whole request, including slow-drip bodies.
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    const resolve: typeof resolvePromise = (value) => {
      clearTimeout(timer);
      resolvePromise(value);
    };
    const reject = (error: unknown) => {
      clearTimeout(timer);
      rejectPromise(
        error instanceof Error
          ? error
          : new LinkPreviewFetchError(String(error)),
      );
    };

    const client = url.protocol === "https:" ? https : http;
    const request = client.request(
      url,
      {
        method: "GET",
        lookup: createSafeLookup(options.allowPrivateAddresses),
        // Never reuse pooled sockets: each request is validated afresh.
        agent: false,
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "accept-encoding": "gzip, deflate, br",
          "accept-language": "en;q=0.9, *;q=0.5",
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;

        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          resolve({ kind: "redirect", location: response.headers.location });
          return;
        }

        if (status < 200 || status >= 300) {
          response.resume();
          reject(new LinkPreviewFetchError(`Unexpected status ${status}`));
          return;
        }

        const contentType = (response.headers["content-type"] ?? "")
          .toString()
          .toLowerCase();
        const isHtml =
          contentType.includes("text/html") ||
          contentType.includes("application/xhtml+xml");

        // Only HTML needs a body; other types are described from headers.
        if (!isHtml) {
          response.destroy();
          resolve({ kind: "page", contentType, body: Buffer.alloc(0) });
          return;
        }

        const stream = decompress(response);
        const chunks: Buffer[] = [];
        let size = 0;
        let finished = false;

        const finish = () => {
          if (finished) return;
          finished = true;
          resolve({ kind: "page", contentType, body: Buffer.concat(chunks) });
          response.destroy();
          stream.destroy();
        };

        stream.on("data", (chunk: Buffer) => {
          if (finished) return;
          const allowed = options.maxBytes - size;
          chunks.push(
            chunk.length > allowed ? chunk.subarray(0, allowed) : chunk,
          );
          size += Math.min(chunk.length, allowed);
          // Stop once the size cap is reached or the head is complete.
          if (
            size >= options.maxBytes ||
            /<\/head\s*>/i.test(chunk.toString("latin1"))
          ) {
            finish();
          }
        });
        stream.on("end", finish);
        const fail = (error: unknown) => {
          if (finished) return;
          finished = true;
          reject(error);
        };
        stream.on("error", fail);
        response.on("error", fail);
      },
    );

    timer = setTimeout(() => {
      request.destroy(new LinkPreviewFetchError("Timed out"));
    }, remaining);
    request.on("error", (error) => reject(error));
    request.end();
  });

/**
 * Fetches a public web page for link previews. Refuses private and internal
 * addresses, follows a limited number of redirects (each one re-validated),
 * and caps both the time spent and the bytes read.
 */
export const fetchPage = async (
  rawUrl: string,
  options: FetchPageOptions = {},
): Promise<FetchedPage> => {
  const resolved = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    allowPrivateAddresses: options.allowPrivateAddresses ?? false,
  };
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const deadline = Date.now() + resolved.timeoutMs;

  let url = assertFetchableUrl(rawUrl, resolved.allowPrivateAddresses);

  for (let redirects = 0; ; redirects++) {
    const result = await requestOnce(url, resolved, deadline);
    if (result.kind === "page") {
      return {
        finalUrl: url.toString(),
        contentType: result.contentType,
        body: result.body,
      };
    }
    if (redirects >= maxRedirects) {
      throw new LinkPreviewFetchError("Too many redirects");
    }
    let next: string;
    try {
      next = new URL(result.location, url).toString();
    } catch {
      throw new LinkPreviewFetchError("Invalid redirect");
    }
    url = assertFetchableUrl(next, resolved.allowPrivateAddresses);
  }
};
