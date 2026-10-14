/**
 * In-app PDF reading, without a native module.
 *
 * A native PDF library (react-native-pdf) would need a custom dev build, ending the Expo Go
 * workflow. So PDF.js renders the PDF inside the WebView we already depend on.
 *
 * This works because **arXiv serves PDFs with `access-control-allow-origin: *`** (verified),
 * and also supports **range requests** (`accept-ranges: bytes`, 206 on a ranged GET) — so
 * PDF.js streams only the bytes it needs.
 *
 * Notes on speed:
 *   - The raster is capped at devicePixelRatio 2. A modern phone reports 3, and rendering
 *     every page at 3x is more than twice the work for detail nobody can see at this size.
 *   - Page 1 is drawn and awaited before the scroll observer is attached.
 *   - `rangeChunkSize` is raised from the 64 KB default, cutting round trips to arXiv.
 *
 * Colour is driven by CSS custom properties and `window.__dpTheme`, so the app can switch
 * theme on a loaded document. Rebuilding the HTML to change colour would reload the PDF and
 * lose the reader's page.
 *
 * The classic UMD build is used rather than v4's ESM one: module loading from a null-origin
 * document is exactly what WebViews differ on.
 */

const PDFJS_VERSION = '3.11.174';
const PDFJS_BASE = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;

export interface ReadingSpotLike {
  fraction: number;
  anchor: number;
}

export interface PdfViewerOptions {
  /** Absolute URL of the PDF. */
  url: string;
  theme: 'light' | 'dark';
  /** Where to reopen, where anchor is a page index. */
  start?: ReadingSpotLike | null;
}

export function pdfViewerHtml({ url, theme, start }: PdfViewerOptions): string {
  const startFraction = start?.fraction ?? 0;
  const startAnchor = start?.anchor ?? -1;

  return `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5">
<link rel="preconnect" href="https://cdnjs.cloudflare.com" crossorigin>
<style>
  html[data-theme='dark'] {
    --bg: #16181c; --fg: #e6e6e6; --dim: #8b9199; --page: #1e2126;
  }
  html[data-theme='light'] {
    --bg: #f2f2f4; --fg: #1a1a1a; --dim: #5f6570; --page: #ffffff;
  }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    overflow-x: hidden; overflow-x: clip;
    /* Same reasoning as the HTML reader: a horizontal swipe must not drag the document.
       pinch-zoom is allowed through because a scanned PDF genuinely needs it, whereas
       reflowed text does not. */
    touch-action: pan-y pinch-zoom;
    overscroll-behavior-x: none; }
  #status { padding: 28px 20px; color: var(--dim); }
  #pages { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 10px 0 40px; }
  .page { position: relative; background: var(--page); box-shadow: 0 1px 4px rgba(0,0,0,.25);
    max-width: 100%; }
  .page canvas { display: block; max-width: 100%; height: auto; }
  .page .num { position: absolute; right: 6px; bottom: 4px; font-size: 10px; color: var(--dim); }
  #bar { position: fixed; left: 0; right: 0; bottom: 0; padding: 6px 12px; font-size: 11px;
    color: var(--dim); text-align: center; background: var(--bg); opacity: .92; }
</style>
</head>
<body>
<div id="status">Loading PDF…</div>
<div id="pages"></div>
<div id="bar"></div>
<script src="${PDFJS_BASE}/pdf.min.js"></script>
<script>
(function () {
  var status = document.getElementById('status');
  var pagesEl = document.getElementById('pages');
  var bar = document.getElementById('bar');
  var PDF_URL = ${JSON.stringify(url)};
  var START_FRACTION = ${startFraction};
  var START_ANCHOR = ${startAnchor};

  window.__dpTheme = function (t) {
    document.documentElement.setAttribute('data-theme', t);
  };

  function post(message) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(message));
    }
  }

  if (!window.pdfjsLib) {
    status.textContent = 'Could not load the PDF engine. Check the connection and reopen.';
    post({ type: 'error', message: 'pdfjs unavailable' });
    return;
  }
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = '${PDFJS_BASE}/pdf.worker.min.js';

  var slots = [];
  function span() { return document.documentElement.scrollHeight - window.innerHeight; }
  function fractionNow() { var sp = span(); return sp > 0 ? window.scrollY / sp : 0; }

  // Anchor is a page index, which makes the PDF path use the same position model as HTML.
  function currentAnchor() {
    for (var i = 0; i < slots.length; i++) {
      if (slots[i].getBoundingClientRect().bottom > 8) return i;
    }
    return -1;
  }

  function applyRestore() {
    if (START_ANCHOR >= 0 && slots[START_ANCHOR]) {
      slots[START_ANCHOR].scrollIntoView({ block: 'start' });
      return true;
    }
    var sp = span();
    if (START_FRACTION > 0 && sp > 0) {
      window.scrollTo(0, START_FRACTION * sp);
      return true;
    }
    return false;
  }

  var userMoved = false;
  ['touchstart', 'wheel', 'keydown'].forEach(function (evt) {
    window.addEventListener(evt, function () { userMoved = true; }, { passive: true });
  });

  window.__dpRestore = function () {
    userMoved = false;
    var ok = applyRestore();
    var result = { type: 'restored', ok: ok, fraction: fractionNow(), anchor: currentAnchor() };
    post(result);
    return result;
  };

  var lastSent = 0;
  function report() {
    var now = Date.now();
    if (now - lastSent < 400) return;
    lastSent = now;
    bar.textContent = Math.round(fractionNow() * 100) + '%';
    post({ type: 'position', fraction: fractionNow(), anchor: currentAnchor() });
  }
  window.addEventListener('scroll', report, { passive: true });

  window.pdfjsLib.getDocument({
    url: PDF_URL,
    rangeChunkSize: 262144,
    isEvalSupported: false
  }).promise.then(function (pdf) {
    status.remove();
    post({ type: 'loaded', pages: pdf.numPages });

    pdf.getPage(1).then(function (first) {
      var unscaled = first.getViewport({ scale: 1 });
      var width = Math.min(window.innerWidth, 1000) - 16;
      var scale = width / unscaled.width;
      var ratio = Math.min(window.devicePixelRatio || 1, 2);

      for (var n = 1; n <= pdf.numPages; n++) {
        var slot = document.createElement('div');
        slot.className = 'page';
        slot.style.width = width + 'px';
        slot.dataset.page = n;
        pagesEl.appendChild(slot);
        slots.push(slot);
      }

      var vp1 = first.getViewport({ scale: scale });
      slots.forEach(function (s) { s.style.height = Math.round(vp1.height) + 'px'; });

      var rendering = {};
      function render(n, done) {
        if (rendering[n]) { if (done) done(); return; }
        rendering[n] = true;
        var slot = slots[n - 1];
        if (!slot) { if (done) done(); return; }
        pdf.getPage(n).then(function (p) {
          var vp = p.getViewport({ scale: scale });
          var canvas = document.createElement('canvas');
          canvas.width = Math.floor(vp.width * ratio);
          canvas.height = Math.floor(vp.height * ratio);
          canvas.style.width = vp.width + 'px';
          canvas.style.height = vp.height + 'px';
          slot.style.height = '';
          slot.appendChild(canvas);
          var num = document.createElement('span');
          num.className = 'num';
          num.textContent = n;
          slot.appendChild(num);
          var ctx = canvas.getContext('2d');
          ctx.scale(ratio, ratio);
          p.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
            if (done) done();
          });
        });
      }

      // Draw page 1 and wait for it before anything else, so the paper is on screen as
      // early as possible.
      render(1, function () {
        if (START_ANCHOR >= 0 || START_FRACTION > 0) {
          // Same shape as the HTML reader's settle loop, and for the same reason: a fixed
          // attempt count can expire before the document has finished growing. Here the
          // height keeps changing as later pages get their canvases, so the loop runs until
          // it stops changing rather than for a set number of tries.
          var attempts = 0;
          var lastHeight = -1;
          var stableFor = 0;
          (function settle() {
            if (userMoved || attempts++ > 60) return;
            applyRestore();
            var h = document.documentElement.scrollHeight;
            if (h > 0 && h === lastHeight) {
              if (++stableFor >= 4) return;
            } else {
              stableFor = 0;
              lastHeight = h;
            }
            setTimeout(settle, 350);
          })();
        }
        report();
        // Tell the app the document is up, so it can drive and verify restore.
        post({ type: 'ready' });

        for (var k = 2; k <= Math.min(3, pdf.numPages); k++) render(k);

        var observer = new IntersectionObserver(function (entries) {
          entries.forEach(function (e) {
            if (e.isIntersecting) render(Number(e.target.dataset.page));
          });
        }, { rootMargin: '800px 0px' });
        slots.forEach(function (s) { observer.observe(s); });
      });
    });
  }).catch(function (err) {
    status.textContent = 'Could not open this PDF: ' + (err && err.message ? err.message : err);
    post({ type: 'error', message: String(err && err.message ? err.message : err) });
  });
})();
</script>
</body></html>`;
}
