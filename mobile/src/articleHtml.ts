/**
 * Fetching an article and preparing it before the WebView parses it.
 *
 * The WebView can load arXiv's URL directly, and most of the time that is the right thing —
 * the browser streams and renders progressively. But it cannot lazily load figures that way.
 *
 * arXiv marks no image `loading="lazy"` (checked: 0 of 12 `<img>` tags on a sample paper), so
 * every figure starts downloading during parse. On a 15,000-word paper that is 62 figures and
 * 28.0 MB against 388 KB of text.
 *
 * The obvious fix — inject a script that sets the attribute — does not work. Chromium's
 * preload scanner finds `<img src>` in the raw bytes and starts the fetch before any script
 * runs, and `loading` is only consulted at that moment. Adding the attribute afterwards has
 * no effect on fetches already begun.
 *
 * So the attribute has to be in the markup before parsing. That means fetching the HTML,
 * rewriting it, and handing the string to the WebView. This module does the rewrite.
 *
 * The rewrite is deliberately minimal: a `<base>` so relative figure URLs still resolve, and
 * the two attributes. Stripping arXiv's chrome as well would be tempting, but every removal
 * is a way for a paper to render wrong, and the stylesheet already hides what it needs to.
 *
 * Scope note: only `<img>` is handled. Vector figures are `<object type="image/svg+xml">` on
 * arXiv, and `<object>` has no `loading` attribute. Deferring its `data` would mean replacing
 * the attribute and restoring it on intersection — more moving parts, and a failure mode where
 * a figure silently never renders. Vector figures are small; the raster ones are the payload.
 * So they are left eager, on purpose.
 */

const ARTICLE_BASE = 'https://arxiv.org/html/';

/** Add lazy loading to every image that does not already declare a loading strategy. */
function addLazyAttributes(html: string): string {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    if (/\bloading\s*=/i.test(tag)) return tag;
    // `async` keeps image decode off the main thread, which matters while scrolling.
    return tag.replace(/\s*\/?>$/, (end) => ` loading="lazy" decoding="async"${end}`);
  });
}

/**
 * Prepare raw article HTML for the WebView.
 *
 * The `<base>` element is what makes this safe: the saved markup is parsed from a string, so
 * every relative URL — figure paths, arXiv's own stylesheet — would otherwise resolve against
 * nothing. With it, they resolve against the paper's own URL exactly as they would have if the
 * WebView had loaded that URL directly.
 */
export function prepareArticleHtml(html: string, id: string): string {
  // No trailing slash. Figure paths carry the version — `2610.13947v3/teaser_rooms.png` — and
  // are written relative to the paper's own URL, so the base must be that URL exactly.
  // With a trailing slash they resolve one directory too deep and every figure 404s.
  const base = `<base href="${ARTICLE_BASE}${id}">`;
  const withBase = /<head[^>]*>/i.test(html)
    ? html.replace(/<head([^>]*)>/i, `<head$1>${base}`)
    : `${base}${html}`;
  return addLazyAttributes(withBase);
}

/**
 * Fetch and prepare an article.
 *
 * Returns null rather than throwing when anything goes wrong, because the caller has a
 * perfectly good fallback: load the URL directly. A failed fetch should degrade to the old
 * behaviour, not to an error screen.
 */
export async function fetchArticleHtml(id: string): Promise<string | null> {
  try {
    const response = await fetch(`${ARTICLE_BASE}${id}`);
    if (!response.ok) return null;
    return prepareArticleHtml(await response.text(), id);
  } catch {
    return null;
  }
}
