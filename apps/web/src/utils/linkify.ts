// Bare web addresses in text, stopping before trailing punctuation.
const URL_SOURCE = String.raw`\bhttps?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]}]`;

// Text inside these elements is never turned into links.
const SKIP_SELECTOR = "a, code, pre, [data-type='mention']";

/**
 * Wraps bare http(s) addresses in editor HTML with links, so text that was
 * imported or saved without links (e.g. from Trello) is clickable too.
 * Returns the input unchanged when it has no bare addresses.
 */
export const linkifyHtml = (html: string): string => {
  if (typeof window === "undefined" || !/https?:\/\//i.test(html)) return html;
  // Markdown content is linkified by the editor's Markdown parser instead.
  if (!html.trimStart().startsWith("<")) return html;

  const doc = new DOMParser().parseFromString(html, "text/html");
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (text.parentElement?.closest(SKIP_SELECTOR)) continue;
    if (new RegExp(URL_SOURCE, "i").test(text.data)) textNodes.push(text);
  }
  if (textNodes.length === 0) return html;

  for (const textNode of textNodes) {
    const fragment = doc.createDocumentFragment();
    const value = textNode.data;
    let lastIndex = 0;
    for (const match of value.matchAll(new RegExp(URL_SOURCE, "gi"))) {
      const start = match.index;
      if (start > lastIndex) {
        fragment.append(value.slice(lastIndex, start));
      }
      const anchor = doc.createElement("a");
      anchor.href = match[0];
      anchor.textContent = match[0];
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      fragment.append(anchor);
      lastIndex = start + match[0].length;
    }
    if (lastIndex < value.length) fragment.append(value.slice(lastIndex));
    textNode.replaceWith(fragment);
  }

  return doc.body.innerHTML;
};
