/**
 * The script injected into the reader WebView.
 *
 * Extracted from the screen so it can be exercised directly against real arXiv HTML in a
 * browser (mobile/harness/check_restore.py). This is the most fragile part of the app: it
 * runs before the document exists, has to survive lazy figures changing the page height
 * underneath it, and has to produce a position that still means something after a reload.
 *
 * The page talks back over `window.ReactNativeWebView.postMessage` with:
 *   { type: 'ready' }                                 once the document has loaded
 *   { type: 'position', fraction, anchor }            on scroll, throttled
 *   { type: 'restored', ok, fraction, anchor }        in reply to __dpRestore()
 *
 * Restore is deliberately belt-and-braces:
 *
 *  1. The script restores on its own, but only after `DOMContentLoaded`, and it will not
 *     stop on a "stable" height until `readyState` is `complete`. An earlier version exited
 *     as soon as the height stopped changing — which is also true of a page that has not
 *     started loading yet, so on a slow connection it gave up immediately, having restored
 *     nothing. That is the bug that made restore look broken.
 *  2. The app also drives it: on 'ready' it calls __dpRestore(), reads back where the page
 *     landed, and retries if that is not where it asked for. Closure over the real result
 *     rather than hoping a timer fired at the right moment.
 *  3. And the header button calls the same function on demand.
 */

export interface ReadingSpotLike {
  fraction: number;
  anchor: number;
}

/**
 * Block-level elements used for anchoring.
 *
 * Deliberately generous. A paper whose structure is not in this list should still anchor to
 * something, and an index into a longer list is no less stable than one into a shorter list.
 */
export const BLOCK_SELECTOR = [
  'article p',
  'article h2',
  'article h3',
  'article h4',
  'article figure',
  'article table',
  'article section',
  'article li',
  'article .ltx_para',
].join(', ');

/** Injected into the loaded page by the restore button and by the app's retry loop. */
export const RESTORE_JS = 'window.__dpRestore && window.__dpRestore(); true;';

/** Recolour an already-loaded page without reloading it. */
export function themeJs(theme: 'light' | 'dark'): string {
  return `if (window.__dpTheme) { window.__dpTheme(${JSON.stringify(theme)}); } true;`;
}

/**
 * Re-apply the stylesheet and theme to an already-loaded page.
 *
 * Passed as `injectedJavaScript` alongside the before-content-load script, as a backstop.
 * `injectedJavaScriptBeforeContentLoaded` is the right place for the stylesheet — it runs
 * before arXiv's own CSS paints, so the desktop layout never flashes — but it does not fire
 * reliably on every load on every WebView. When it silently does not, arXiv's own stylesheets
 * win outright: its dark site header and its icon-only toolbar reappear above the app's
 * header, which reads as two navigation bars, and the page regains a horizontal scroll.
 *
 * That is the "it happens on some papers" report. This runs after the document loads and is
 * idempotent, so a missed stylesheet is corrected rather than left on screen.
 */
export function ensureReaderCssJs(css: string, theme: 'light' | 'dark'): string {
  return `
    var __dpStyle = document.getElementById('__reader_css');
    if (!__dpStyle) {
      __dpStyle = document.createElement('style');
      __dpStyle.id = '__reader_css';
      (document.head || document.documentElement).appendChild(__dpStyle);
    }
    __dpStyle.textContent = ${JSON.stringify(css)};
    document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)});
    true;
  `;
}

export interface ScriptOptions {
  css: string;
  theme: 'light' | 'dark';
  spot?: ReadingSpotLike | null;
  blockSelector?: string;
  /** Upper bound on self-restore attempts; each is one settle interval. */
  settleTries?: number;
  settleDelayMs?: number;
}

export function buildReaderScript({
  css,
  theme,
  spot,
  blockSelector = BLOCK_SELECTOR,
  settleTries = 80,
  settleDelayMs = 350,
}: ScriptOptions): string {
  const startFraction = spot?.fraction ?? 0;
  const startAnchor = spot?.anchor ?? -1;

  return `
    (function () {
      var css = ${JSON.stringify(css)};
      var theme = ${JSON.stringify(theme)};
      var startFraction = ${startFraction};
      var startAnchor = ${startAnchor};
      var BLOCK_SELECTOR = ${JSON.stringify(blockSelector)};
      var SETTLE_TRIES = ${settleTries};
      var SETTLE_DELAY = ${settleDelayMs};

      function applyCss() {
        var s = document.getElementById('__reader_css');
        if (!s) {
          s = document.createElement('style');
          s.id = '__reader_css';
          (document.head || document.documentElement).appendChild(s);
        }
        s.textContent = css;
      }

      // Sets the attribute the stylesheet keys off. Exposed so the app can switch theme on a
      // loaded page -- remounting the WebView to change colour would reload the article and
      // lose the reader's place.
      window.__dpTheme = function (t) {
        document.documentElement.setAttribute('data-theme', t);
      };

      applyCss();
      window.__dpTheme(theme);
      document.addEventListener('DOMContentLoaded', function () {
        applyCss();
        window.__dpTheme(theme);
      });

      function post(m) {
        if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(m));
      }
      function span() { return document.documentElement.scrollHeight - window.innerHeight; }
      function blocks() { return document.querySelectorAll(BLOCK_SELECTOR); }
      function fractionNow() {
        var sp = span();
        return sp > 0 ? window.scrollY / sp : 0;
      }

      function currentAnchor() {
        var nodes = blocks();
        for (var i = 0; i < nodes.length; i++) {
          if (nodes[i].getBoundingClientRect().bottom > 8) return i;
        }
        return -1;
      }

      function applyRestore() {
        var nodes = blocks();
        if (startAnchor >= 0 && nodes[startAnchor]) {
          nodes[startAnchor].scrollIntoView({ block: 'start' });
          return true;
        }
        var sp = span();
        if (startFraction > 0 && sp > 0) {
          window.scrollTo(0, startFraction * sp);
          return true;
        }
        return false;
      }

      var userMoved = false;
      ['touchstart', 'wheel', 'keydown'].forEach(function (evt) {
        window.addEventListener(evt, function () { userMoved = true; }, { passive: true });
      });

      // Returns where the page ACTUALLY ended up, so the app can check rather than assume.
      window.__dpRestore = function () {
        userMoved = false;
        var ok = applyRestore();
        var result = { type: 'restored', ok: ok, fraction: fractionNow(), anchor: currentAnchor() };
        post(result);
        return result;
      };

      function beginSettle() {
        var attempts = 0;
        var lastHeight = -1;
        var stableFor = 0;

        (function settle() {
          if (userMoved || attempts++ > SETTLE_TRIES) return;
          applyRestore();

          var h = document.documentElement.scrollHeight;
          // Only treat a steady height as "finished" once the document has actually
          // finished loading. A blank page is also a steady page.
          if (document.readyState === 'complete' && h > 0 && h === lastHeight) {
            if (++stableFor >= 3) return;
          } else {
            stableFor = 0;
            lastHeight = h;
          }
          setTimeout(settle, SETTLE_DELAY);
        })();
      }

      if (startAnchor >= 0 || startFraction > 0) {
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', beginSettle);
        } else {
          beginSettle();
        }
      }

      // Tell the app the page is ready, so it can drive restore and verify the result
      // instead of relying on this script's own timing.
      function announceReady() {
        if (startAnchor >= 0 || startFraction > 0) applyRestore();
        post({ type: 'ready' });
      }
      if (document.readyState === 'complete') {
        announceReady();
      } else {
        window.addEventListener('load', announceReady);
      }

      var last = 0;
      window.addEventListener('scroll', function () {
        var now = Date.now();
        if (now - last < 600) return;
        last = now;
        post({ type: 'position', fraction: fractionNow(), anchor: currentAnchor() });
      }, { passive: true });

      true;
    })();
  `;
}
