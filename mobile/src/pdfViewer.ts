/**
 * In-app PDF reading, without a native module.
 *
 * A native PDF library (react-native-pdf) would require a custom dev build, which would end
 * the Expo Go workflow. So the PDF is rendered by PDF.js inside the WebView, which we already
 * depend on.
 *
 * This works because **arXiv serves PDFs with `access-control-allow-origin: *`** (verified),
 * so PDF.js can fetch one cross-origin from a page whose origin is null. No proxy, no
 * download-and-store step, no native code.
 *
 * Build choice: PDF.js 3.11.174's classic UMD bundle, loaded with a plain `<script src>`.
 * The v4 ESM builds would need module loading from a null-origin document, which is exactly
 * the sort of thing WebViews differ on.
 *
 * Pages are laid out as placeholders with the correct aspect ratio and drawn only as they
 * near the viewport, so a 60-page paper does not rasterise 60 canvases before showing
 * anything — and so the document height is stable before the first page renders, which is
 * what makes restoring a scroll position reliable.
 */

const PDFJS_VERSION = '3.11.174';
const PDFJS_BASE = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;

export interface PdfViewerOptions {
  /** Absolute URL of the PDF. */
  url: string;
  theme: 'light' | 'dark';
  /** 0..1 through the document to restore on open. */
  startFraction?: number | null;
}

export function pdfViewerHtml({ url, theme, startFraction }: PdfViewerOptions): string {
  const bg = theme === 'dark' ? '#16181c' : '#f2f2f4';
  const fg = theme === 'dark' ? '#e6e6e6' : '#1a1a1a';
  const dim = theme === 'dark' ? '#8b9199' : '#5f6570';
  const page = theme === 'dark' ? '#1e2126' : '#ffffff';
  const start = typeof startFraction === 'number' ? startFraction : 0;

  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5">
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
  var START = ${start};

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

  // Report scroll position as a fraction so it survives font-size and layout differences on
  // another device. Throttled: scroll fires far more often than is useful to store.
  var lastSent = 0;
  function report() {
    var now = Date.now();
    if (now - lastSent < 400) return;
    lastSent = now;
    var span = document.documentElement.scrollHeight - window.innerHeight;
    var fraction = span > 0 ? window.scrollY / span : 0;
    bar.textContent = Math.round(fraction * 100) + '%';
    post({ type: 'position', fraction: fraction });
  }
  window.addEventListener('scroll', report, { passive: true });

  window.pdfjsLib.getDocument({ url: PDF_URL }).promise.then(function (pdf) {
    status.remove();
    post({ type: 'loaded', pages: pdf.numPages });

    pdf.getPage(1).then(function (first) {
      var unscaled = first.getViewport({ scale: 1 });
      var width = Math.min(window.innerWidth, 1000) - 16;
      var scale = width / unscaled.width;

      var slots = [];
      for (var n = 1; n <= pdf.numPages; n++) {
        var slot = document.createElement('div');
        slot.className = 'page';
        // Placeholder sized to the real page, so document height is right before rendering.
        slot.style.width = width + 'px';
        slot.dataset.page = n;
        pagesEl.appendChild(slot);
        slots.push(slot);
      }

      pdf.getPage(1).then(function (p) {
        var vp = p.getViewport({ scale: scale });
        slots.forEach(function (s) { s.style.height = Math.round(vp.height) + 'px'; });
        if (START > 0) {
          var span = document.documentElement.scrollHeight - window.innerHeight;
          window.scrollTo(0, Math.max(0, START * span));
          report();
        }
      });

      var rendering = {};
      function render(n) {
        if (rendering[n]) return;
        rendering[n] = true;
        var slot = slots[n - 1];
        pdf.getPage(n).then(function (p) {
          var vp = p.getViewport({ scale: scale });
          var canvas = document.createElement('canvas');
          var ratio = window.devicePixelRatio || 1;
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
          p.render({ canvasContext: ctx, viewport: vp });
        });
      }

      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) render(Number(e.target.dataset.page));
        });
      }, { rootMargin: '600px 0px' });
      slots.forEach(function (s) { observer.observe(s); });

      report();
    });
  }).catch(function (err) {
    status.textContent = 'Could not open this PDF: ' + (err && err.message ? err.message : err);
    post({ type: 'error', message: String(err && err.message ? err.message : err) });
  });
})();
</script>
</body></html>`;
}
