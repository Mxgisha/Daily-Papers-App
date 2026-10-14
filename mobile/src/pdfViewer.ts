/**
 * In-app PDF reading, without a native module.
 *
 * A native PDF library (react-native-pdf) would need a custom dev build, ending the Expo Go
 * workflow. So PDF.js renders the PDF inside the WebView we already depend on.
 *
 * This works because **arXiv serves PDFs with `access-control-allow-origin: *`** (verified),
 * and also supports **range requests** (`accept-ranges: bytes`, 206 on a ranged GET) — so
 * PDF.js streams only the bytes it needs rather than pulling a 2 MB file before drawing
 * anything.
 *
 * Notes on speed, since the first version was slow:
 *   - The raster is capped at devicePixelRatio 2. A modern phone reports 3, and rendering
 *     every page at 3x is more than twice the work for detail nobody can see at this size.
 *   - Page 1 is drawn and awaited before the scroll observer is attached, so the paper
 *     appears as early as possible rather than after the observer's first callback.
 *   - The first few pages are rendered eagerly; the rest stay lazy.
 *   - `rangeChunkSize` is raised from the 64 KB default, which cuts the number of round
 *     trips to arXiv substantially.
 *
 * Vectors are used for the classic UMD build rather than v4's ESM one: module loading from a
 * null-origin document is exactly what WebViews differ on.
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
  const bg = theme === 'dark' ? '#16181c' : '#f2f2f4';
  const fg = theme === 'dark' ? '#e6e6e6' : '#1a1a1a';
  const dim = theme === 'dark' ? '#8b9199' : '#5f6570';
  const page = theme === 'dark' ? '#1e2126' : '#ffffff';
  const startFraction = start?.fraction ?? 0;
  const startAnchor = start?.anchor ?? -1;

  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5">
<link rel="preconnect" href="https://cdnjs.cloudflare.com" crossorigin>
<style>
  html, body { margin: 0; padding: 0; background: ${bg}; color: ${fg};
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    overflow-x: hidden; }
  #status { padding: 28px 20px; color: ${dim}; }
  #pages { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 10px 0 40px; }
  .page { position: relative; background: ${page}; box-shadow: 0 1px 4px rgba(0,0,0,.25);
    max-width: 100%; }
  .page canvas { display: block; max-width: 100%; height: auto; }
  .page .num { position: absolute; right: 6px; bottom: 4px; font-size: 10px; color: ${dim}; }
  #bar { position: fixed; left: 0; right: 0; bottom: 0; padding: 6px 12px; font-size: 11px;
    color: ${dim}; text-align: center; background: ${bg}; opacity: .92; }
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
      return;
    }
    var sp = span();
    if (START_FRACTION > 0 && sp > 0) window.scrollTo(0, START_FRACTION * sp);
  }

  var userMoved = false;
  ['touchstart', 'wheel', 'keydown'].forEach(function (evt) {
    window.addEventListener(evt, function () { userMoved = true; }, { passive: true });
  });

  var lastSent = 0;
  function report() {
    var now = Date.now();
    if (now - lastSent < 400) return;
    lastSent = now;
    var sp = span();
    var fraction = sp > 0 ? window.scrollY / sp : 0;
    bar.textContent = Math.round(fraction * 100) + '%';
    post({ type: 'position', fraction: fraction, anchor: currentAnchor() });
  }
  window.addEventListener('scroll', report, { passive: true });

  window.pdfjsLib.getDocument({
    url: PDF_URL,
    // Fewer, larger range requests: the default 64 KB makes many round trips to arXiv.
    rangeChunkSize: 262144,
    // Skips a capability probe that costs time and is not needed here.
    isEvalSupported: false
  }).promise.then(function (pdf) {
    status.remove();
    post({ type: 'loaded', pages: pdf.numPages });

    pdf.getPage(1).then(function (first) {
      var unscaled = first.getViewport({ scale: 1 });
      var width = Math.min(window.innerWidth, 1000) - 16;
      var scale = width / unscaled.width;
      // Capped at 2. A phone reporting 3 would rasterise every page at 3x for no visible
      // gain at this size.
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
      // early as possible. This is the main perceptual win over the first version.
      render(1, function () {
        if (START_ANCHOR >= 0 || START_FRACTION > 0) {
          var tries = 0;
          (function settle() {
            if (userMoved || tries++ > 12) return;
            applyRestore();
            setTimeout(settle, 350);
          })();
        }
        report();

        // A couple more immediately for continuity while scrolling starts.
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
