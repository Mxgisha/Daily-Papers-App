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

const PROXY = (process.env.EXPO_PUBLIC_READER_PROXY ?? '').replace(/\/$/, '');
const ARXIV_HTML = 'https://arxiv.org/html';

type Status = 'probing' | 'ready' | 'unavailable';

const shell: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  backgroundColor: '#16181c',
  color: '#e6e6e6',
  font: '15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  padding: '28px 22px',
  gap: 12,
};

export default function ReaderWeb() {
  const params = useLocalSearchParams<{ id: string }>();
  // Old-style ids arrive percent-encoded (math.GT%2F0309136) so the route stays one segment.
  const id = decodeURIComponent(String(params.id ?? ''));
  const [status, setStatus] = useState<Status>(PROXY ? 'probing' : 'ready');

  const src = PROXY ? `${PROXY}/read/${id}` : `${ARXIV_HTML}/${id}`;
  const pdf = `https://arxiv.org/pdf/${id}`;

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
    return (
      <div style={shell}>
        <h1 style={{ fontSize: 20, margin: 0 }}>No HTML full text</h1>
        <p style={{ margin: 0, color: '#a8adb5' }}>
          {id} has no rendered HTML on arXiv. This is the ~4% of papers that need the PDF
          fallback.
        </p>
        <a
          href={pdf}
          target="_blank"
          rel="noreferrer"
          style={{
            alignSelf: 'flex-start',
            marginTop: 6,
            padding: '10px 16px',
            border: '1px solid #3a3f47',
            borderRadius: 8,
            color: '#8ab4f8',
            textDecoration: 'none',
          }}
        >
          Open PDF
        </a>
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
