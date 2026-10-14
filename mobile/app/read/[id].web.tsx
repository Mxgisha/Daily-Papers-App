/**
 * Reader — web variant.
 *
 * `react-native-webview` has no web implementation, so this file exists purely so the reader
 * can be *executed and verified* in a browser rather than only compiled. Native uses
 * `read/[id].tsx`, which injects the reader stylesheet into a WebView; that is impossible
 * here because injecting into a cross-origin iframe is blocked by the browser.
 *
 * So on web the paper is loaded through a same-origin proxy when one is configured
 * (`EXPO_PUBLIC_READER_PROXY`, which is what `reader/server.py` serves), and straight from
 * arXiv otherwise. Only the first path is restyled — which is exactly why the proxy exists.
 */

import { useLocalSearchParams } from 'expo-router';

const PROXY = process.env.EXPO_PUBLIC_READER_PROXY ?? '';
const ARXIV_HTML = 'https://arxiv.org/html';

export default function ReaderWeb() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const src = PROXY ? `${PROXY.replace(/\/$/, '')}/read/${id}` : `${ARXIV_HTML}/${id}`;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        backgroundColor: '#16181c',
      }}
    >
      <iframe
        src={src}
        title={`arXiv ${id}`}
        // No sandbox: the restyled article needs to load cross-origin figures from arXiv.
        style={{ flex: 1, width: '100%', border: 0, backgroundColor: '#16181c' }}
      />
    </div>
  );
}
