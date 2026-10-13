/* Reader instrumentation and controls.
 *
 * The metrics object is written into the DOM (not merely logged) so the headless pass can
 * read it back with `chromium --dump-dom`. That is the only way to measure a real reflow:
 * scroll height, page-level horizontal overflow, and the actual bytes spent on figures.
 */
(function () {
  'use strict';

  var metricsEl = document.getElementById('__metrics');

  /* Nodes inside a horizontal scroller (tables, display math) are *supposed* to be wider
   * than the viewport. Only page-level overflow counts as a layout failure. */
  function inScroller(node) {
    var p = node.parentElement;
    while (p && p !== document.body) {
      var ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
      p = p.parentElement;
    }
    return false;
  }

  function overflowing() {
    var limit = document.documentElement.clientWidth;
    var out = [];
    var nodes = document.querySelectorAll('article *');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var rect = node.getBoundingClientRect();
      /* Check the right *edge*, not the width: an element can be narrow but positioned
       * far enough right to overflow the page. Width-only checks miss exactly that. */
      if (rect.right > limit + 1 && !inScroller(node)) {
        var cls = node.className ? '.' + String(node.className).trim().split(/\s+/)[0] : '';
        out.push(node.tagName.toLowerCase() + cls + '@right=' + Math.round(rect.right));
        if (out.length >= 12) break;
      }
    }
    return out;
  }

  function resourceBytes() {
    var img = 0, total = 0, entries = performance.getEntriesByType('resource');
    for (var i = 0; i < entries.length; i++) {
      var r = entries[i];
      var size = r.transferSize || r.encodedBodySize || 0;
      total += size;
      if (r.initiatorType === 'img' || /\.(png|jpe?g|gif|svg|webp|avif)$/i.test(r.name)) img += size;
    }
    return { img: img, total: total };
  }

  function collect() {
    var doc = document.documentElement;
    var imgs = Array.prototype.slice.call(document.images);
    var bytes = resourceBytes();
    var vw = window.innerWidth, vh = window.innerHeight;
    var tables = Array.prototype.slice.call(document.querySelectorAll('table'));
    return {
      viewport: [vw, vh],
      scroll_height: doc.scrollHeight,
      screens: +(doc.scrollHeight / vh).toFixed(2),
      page_overflow_x: doc.scrollWidth > doc.clientWidth + 1,
      scroll_width: doc.scrollWidth,
      client_width: doc.clientWidth,
      overflowing_elements: overflowing(),
      images: imgs.length,
      broken_images: imgs.filter(function (i) { return i.complete && i.naturalWidth === 0; }).length,
      image_bytes: bytes.img,
      resource_bytes: bytes.total,
      math: document.querySelectorAll('math').length,
      display_math: document.querySelectorAll('math[display="block"]').length,
      tables: tables.length,
      wide_tables: tables.filter(function (t) { return t.scrollWidth > t.clientWidth + 1; }).length,
      dom_nodes: document.querySelectorAll('*').length,
      ready_ms: Math.round(performance.now())
    };
  }

  function write() {
    if (metricsEl) metricsEl.textContent = JSON.stringify(collect());
  }

  /* ---- Controls ---- */

  var size = 18, root = document.documentElement;

  var dec = document.getElementById('__dec');
  var inc = document.getElementById('__inc');
  var theme = document.getElementById('__theme');

  if (dec) dec.addEventListener('click', function () {
    size = Math.max(14, size - 1);
    root.style.setProperty('--font-size', size + 'px');
    setTimeout(write, 50);
  });
  if (inc) inc.addEventListener('click', function () {
    size = Math.min(26, size + 1);
    root.style.setProperty('--font-size', size + 'px');
    setTimeout(write, 50);
  });
  if (theme) theme.addEventListener('click', function () {
    var now = root.getAttribute('data-theme');
    root.setAttribute('data-theme', now === 'dark' ? 'light' : 'dark');
    setTimeout(write, 50);
  });

  /* Rewrite internal cross-references so they stay inside the reader instead of jumping
   * out to arxiv.org, and let images load lazily once the layout is known. */
  document.querySelectorAll('article a[href^="#"]').forEach(function (a) { a.setAttribute('data-internal', '1'); });

  write();
  window.addEventListener('load', write);
  setTimeout(write, 1200);
  setTimeout(write, 4000);
})();
