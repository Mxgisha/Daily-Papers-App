/**
 * The script injected into the reader WebView.
 *
 * Extracted from the screen so it can be exercised directly against real arXiv HTML in a
 * browser. This is the most fragile part of the app — it has to run before the document
 * exists, survive lazy figures changing the page height underneath it, and compute a
 * position that still means something after a reload. Inline in a component it could only be
 * reasoned about; as a module it can be tested.
 *
 * The page talks back over `window.ReactNativeWebView.postMessage` with:
 *   { type: 'position', fraction, anchor }   on scroll, throttled
 *   { type: 'restored', ok }                 in reply to __dpRestore()
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

/** Injected into the loaded page by the header button to scroll back to the stored spot. */
export const RESTORE_JS = 'window.__dpRestore && window.__dpRestore(); true;';

export interface ScriptOptions {
  css: string;
  theme: 'light' | 'dark';
  spot?: ReadingSpotLike | null;
  blockSelector?: string;
  /** How many times the automatic restore re-applies while the document settles. */
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

      function apply() {
        document.documentElement.setAttribute('data-theme', theme);
        var s = document.getElementById('__reader_css');
        if (!s) {
          s = document.createElement('style');
          s.id = '__reader_css';
          (document.head || document.documentElement).appendChild(s);
        }
        s.textContent = css;
      }
      apply();
      document.addEventListener('DOMContentLoaded', apply);

      function post(m) {
        if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(m));
      }
      function span() { return document.documentElement.scrollHeight - window.innerHeight; }
      function blocks() { return document.querySelectorAll(BLOCK_SELECTOR); }

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

      // Called by the header button. Clears the guard first: tapping the button is not the
      // same as scrolling away, and without this a reader who scrolled once could never use
      // the button again.
      window.__dpRestore = function () {
        userMoved = false;
        var ok = applyRestore();
        post({ type: 'restored', ok: ok });
        return ok;
      };

      // Best-effort automatic restore.
      //
      // This runs BEFORE the document exists (the app injects at document start), and its
      // first several attempts therefore find an empty page. The original version retried a
      // fixed 14 times at 350ms — about five seconds — and gave up. arXiv's HTML routinely
      // takes longer than that to arrive, so the loop was usually over before there was
      // anything to scroll: the position was saved correctly and simply never applied. Hence
      // the header button, which asks an already-loaded page to scroll.
      //
      // Now it runs until the page stops growing rather than for a fixed count, so it adapts
      // to a slow load instead of racing it, and still stops early on a fast one.
      if (startAnchor >= 0 || startFraction > 0) {
        var attempts = 0;
        var lastHeight = -1;
        var stableFor = 0;

        (function settle() {
          if (userMoved || attempts++ > SETTLE_TRIES) return;
          applyRestore();

          var h = document.documentElement.scrollHeight;
          if (h === lastHeight && h > 0) {
            stableFor++;
            // Height unchanged for a few passes: lazy figures have finished arriving.
            if (stableFor >= 3) return;
          } else {
            stableFor = 0;
            lastHeight = h;
          }
          setTimeout(settle, SETTLE_DELAY);
        })();
      }

      // A late load (or a slow image) can move the target after the loop has stopped.
      window.addEventListener('load', function () {
        if (!userMoved) applyRestore();
      });

      var last = 0;
      window.addEventListener('scroll', function () {
        var now = Date.now();
        if (now - last < 600) return;
        last = now;
        var sp = span();
        post({
          type: 'position',
          fraction: sp > 0 ? window.scrollY / sp : 0,
          anchor: currentAnchor()
        });
      }, { passive: true });

      true;
    })();
  `;
}
