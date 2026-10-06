export interface ParsedMetadata {
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  faviconUrl: string | null;
}

const MAX_TITLE_LENGTH = 300;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_SITE_NAME_LENGTH = 255;
const MAX_URL_LENGTH = 2048;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
};

export const decodeEntities = (value: string): string =>
  value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const isHex = entity[1] === "x" || entity[1] === "X";
      const codePoint = parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (
        !Number.isFinite(codePoint) ||
        codePoint <= 0 ||
        codePoint > 0x10ffff
      ) {
        return match;
      }
      return String.fromCodePoint(codePoint);
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });

const cleanText = (
  value: string | undefined | null,
  maxLength: number,
): string | null => {
  if (!value) return null;
  const text = decodeEntities(value)
    // Strip any markup that slipped into the attribute or title
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
};

/** Resolves a possibly relative URL and only accepts http(s) results. */
export const resolveHttpUrl = (
  value: string | undefined | null,
  baseUrl: string,
): string | null => {
  if (!value) return null;
  try {
    const url = new URL(decodeEntities(value.trim()), baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    const href = url.toString();
    return href.length > MAX_URL_LENGTH ? null : href;
  } catch {
    return null;
  }
};

const parseAttributes = (tag: string): Record<string, string> => {
  const attributes: Record<string, string> = {};
  const attributePattern =
    /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  // Skip the tag name itself
  const body = tag.replace(/^<\s*[a-z]+/i, "").replace(/\/?>$/, "");
  let match: RegExpExecArray | null;
  while ((match = attributePattern.exec(body)) !== null) {
    const name = match[1]?.toLowerCase();
    if (!name || name in attributes) continue;
    attributes[name] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
};

/** Returns the charset declared in a <meta> tag, if any. */
export const findMetaCharset = (html: string): string | null => {
  const charset = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i.exec(html);
  return charset?.[1]?.toLowerCase() ?? null;
};

/**
 * Extracts preview metadata from an HTML document, preferring Open Graph,
 * then Twitter card tags, then standard HTML tags.
 */
export const parseMetadata = (
  html: string,
  baseUrl: string,
): ParsedMetadata => {
  // Metadata lives in <head>; ignore the body when the head is complete.
  const headEnd = html.search(/<\/head\s*>/i);
  const head = headEnd === -1 ? html : html.slice(0, headEnd);
  // Comments and scripts can contain tag-like text.
  const source = head
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, "");

  const meta = new Map<string, string>();
  const icons: { rel: string; href: string }[] = [];
  let documentBase = baseUrl;

  for (const tagMatch of source.matchAll(/<(meta|link|base)\b[^>]*>/gi)) {
    const tagName = tagMatch[1]?.toLowerCase();
    const attributes = parseAttributes(tagMatch[0]);

    if (tagName === "meta") {
      const key = (
        attributes.property ??
        attributes.name ??
        attributes.itemprop
      )
        ?.trim()
        .toLowerCase();
      const content = attributes.content;
      if (key && content !== undefined && !meta.has(key)) {
        meta.set(key, content);
      }
    } else if (tagName === "link") {
      const rel = attributes.rel?.toLowerCase() ?? "";
      if (attributes.href && /\bicon\b/.test(rel)) {
        icons.push({ rel, href: attributes.href });
      }
    } else if (tagName === "base" && attributes.href) {
      documentBase = resolveHttpUrl(attributes.href, baseUrl) ?? documentBase;
    }
  }

  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(source)?.[1];

  const first = (...keys: string[]) => {
    for (const key of keys) {
      const value = meta.get(key);
      if (value?.trim()) return value;
    }
    return undefined;
  };

  const imageUrl = resolveHttpUrl(
    first(
      "og:image:secure_url",
      "og:image",
      "og:image:url",
      "twitter:image",
      "twitter:image:src",
      "image",
    ),
    documentBase,
  );

  // Prefer a regular favicon over the larger apple-touch-icon.
  const icon =
    icons.find((candidate) => !candidate.rel.includes("apple")) ?? icons[0];
  const faviconUrl =
    resolveHttpUrl(icon?.href, documentBase) ??
    resolveHttpUrl("/favicon.ico", baseUrl);

  return {
    title: cleanText(
      first("og:title", "twitter:title") ?? titleTag ?? first("title"),
      MAX_TITLE_LENGTH,
    ),
    description: cleanText(
      first("og:description", "twitter:description", "description"),
      MAX_DESCRIPTION_LENGTH,
    ),
    imageUrl,
    siteName: cleanText(
      first("og:site_name", "application-name", "twitter:site"),
      MAX_SITE_NAME_LENGTH,
    ),
    faviconUrl,
  };
};
