/**
 * Reader — web variant.
 *
 * `react-native-webview` has no web implementation, so this file exists so the reader can be
 * *executed and verified* in a browser rather than only compiled. Native uses
 * `read/[id].tsx`, which injects the reader stylesheet into a WebView; that is impossible
 * here, because a browser will not let you inject into a cross-origin iframe.
 *
 * So on web the paper loads through a same-origin proxy when one is configured
 * (`EXPO_PUBLIC_READER_PROXY`, served by `reader/server.py`), and straight from arXiv
 * otherwise. Only the proxy path is restyled — which is exactly why it exists.
 *
 * The graceful-degradation path matters here: ~4% of arXiv papers have no HTML rendering, and
 * an iframe pointed at one shows arXiv's error page rather than our PDF fallback. The proxy
 * exposes a HEAD probe so this screen can tell the difference.
 */

import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useLocalSearchParams } from 'expo-router';

import { useTheme } from '../../src/theme';

const PROXY = (process.env.EXPO_PUBLIC_READER_PROXY ?? '').replace(/\/$/, '');
const ARXIV_HTML = 'https://arxiv.org/html';

type Status = 'probing' | 'ready' | 'unavailable';

export default function ReaderWeb() {
  const params = useLocalSearchParams<{ id: string }>();
  // Old-style ids arrive percent-encoded (math.GT%2F0309136) so the route stays one segment.
  const id = decodeURIComponent(String(params.id ?? ''));
  const { theme, palette } = useTheme();
  const [status, setStatus] = useState<Status>(PROXY ? 'probing' : 'ready');

  // The proxy renders the article, so the theme has to travel with the request — the app
  // cannot reach into a cross-origin iframe to set it.
  const src = PROXY
    ? `${PROXY}/read/${encodeURIComponent(id)}?theme=${theme}`
    : `${ARXIV_HTML}/${id}`;
  const pdf = `https://arxiv.org/pdf/${id}`;

  const shell: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    backgroundColor: palette.bg,
    color: palette.text,
    font: '15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    padding: '28px 22px',
    gap: 12,
  };

  useEffect(() => {
    if (!PROXY) return;
    let alive = true;
    setStatus('probing');
    fetch(`${PROXY}/read/${id}`, { method: 'HEAD' })
      .then((r) => {
        if (alive) setStatus(r.ok ? 'ready' : 'unavailable');
      })
      // If the probe itself fails, prefer attempting the paper over blocking the reader.
      .catch(() => {
        if (alive) setStatus('ready');
      });
    return () => {
      alive = false;
    };
  }, [id]);

  if (status === 'probing') {
    return <div style={{ ...shell, color: '#8b9199' }}>Loading {id}…</div>;
  }

  if (status === 'unavailable') {
    // Browsers render PDFs natively, so web embeds the file directly and needs no PDF.js.
    // Native has no such luxury, which is why src/pdfViewer.ts exists.
    return (
      <div style={{ ...shell, padding: 0, gap: 0 }}>
        <div
          style={{
            padding: '8px 14px',
            fontSize: 11,
            color: palette.dim,
            borderBottom: `1px solid ${palette.border}`,
          }}
        >
          No HTML full text — showing the PDF
        </div>
        <iframe
          src={pdf}
          title={`arXiv PDF ${id}`}
          style={{ flex: 1, width: '100%', border: 0, backgroundColor: palette.bg }}
        />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, backgroundColor: '#16181c' }}>
      <iframe
        src={src}
        title={`arXiv ${id}`}
        // No sandbox: the restyled article needs to load cross-origin figures from arXiv.
        style={{ flex: 1, width: '100%', border: 0, backgroundColor: '#16181c' }}
      />
    </div>
  );
}
