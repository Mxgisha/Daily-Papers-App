/**
 * Reader screen.
 *
 * Two renderers behind one screen:
 *
 *   HTML  arXiv's own full text in a WebView, with the reader stylesheet injected before
 *         first paint so its desktop CSS never flashes.
 *   PDF   when arXiv has no HTML rendering (~4% of papers), PDF.js draws the PDF in the
 *         WebView. No native module, so this keeps working in Expo Go. This replaced a
 *         dead-end screen that handed off to the OS viewer.
 *
 * Both renderers report scroll position as a fraction of the document, so reading-position
 * memory is one mechanism rather than two.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { ThemeToggle } from '../../src/components/ThemeToggle';
import { useLibrary } from '../../src/library';
import { pdfViewerHtml } from '../../src/pdfViewer';
import { READER_CSS } from '../../src/platform/readerCss.generated';
import { useTheme, type Palette } from '../../src/theme';

const ARXIV_HTML = 'https://arxiv.org/html/';
const ARXIV_PDF = 'https://arxiv.org/pdf/';

export default function ReaderScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  // Old-style ids arrive percent-encoded (math.GT%2F0309136) so the route stays one segment.
  const id = decodeURIComponent(String(params.id ?? ''));
  const { theme, palette } = useTheme();
  const { ready, positionFor, rememberPosition, isFavorite, toggleFavorite } = useLibrary();

  // 'html' until arXiv says otherwise; then 'pdf' for the rest of the session.
  const [renderer, setRenderer] = useState<'html' | 'pdf'>('html');
  // Read once, when storage is available. The WebView is keyed on it so the injected script
  // knows the target rather than being told after the fact.
  const [startFraction, setStartFraction] = useState<number | null>(null);

  const startedRef = useRef(false);
  useEffect(() => {
    if (!ready || startedRef.current) return;
    startedRef.current = true;
    setStartFraction(positionFor(id));
  }, [ready, id, positionFor]);

  const saved = isFavorite(id);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      try {
        const msg = JSON.parse(event.nativeEvent.data) as { type: string; fraction?: number };
        if (msg.type === 'position' && typeof msg.fraction === 'number') {
          rememberPosition(id, msg.fraction);
        }
      } catch {
        // A malformed message from the page is not worth interrupting reading for.
      }
    },
    [id, rememberPosition],
  );

  const injected = useMemo(
    () => `
      (function () {
        var css = ${JSON.stringify(READER_CSS)};
        var theme = ${JSON.stringify(theme)};
        var start = ${typeof startFraction === 'number' ? startFraction : 0};
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
        function restore() { if (start > 0 && span() > 0) window.scrollTo(0, start * span()); }

        // Twice: once as soon as layout exists, once after lazy figures have settled and the
        // document has grown — which is what actually makes the target land correctly.
        if (start > 0) { setTimeout(restore, 350); setTimeout(restore, 1800); }

        var last = 0;
        window.addEventListener('scroll', function () {
          var now = Date.now();
          if (now - last < 500) return;
          last = now;
          post({ type: 'position', fraction: span() > 0 ? window.scrollY / span() : 0 });
        }, { passive: true });

        true;
      })();
    `,
    [theme, startFraction],
  );

  const pdfSource = useMemo(
    () => ({
      html: pdfViewerHtml({ url: `${ARXIV_PDF}${id}`, theme, startFraction }),
    }),
    [id, theme, startFraction],
  );

  const htmlSource = useMemo(() => ({ uri: `${ARXIV_HTML}${id}` }), [id]);
  const styles = useMemo(() => makeStyles(palette), [palette]);

  // Wait for storage so the first paint already knows where to scroll.
  if (!ready) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={palette.accent} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <View style={styles.headerRight}>
              <Pressable
                onPress={() =>
                  toggleFavorite({
                    id,
                    // The reader can be opened cold from a link, in which case the title is
                    // not known and the id stands in rather than saving a blank row.
                    title: id,
                    category: '',
                    published: null,
                    authors: [],
                    abstract: '',
                  })
                }
                testID="reader-save"
                accessibilityRole="button"
                accessibilityLabel={saved ? 'Remove from favorites' : 'Save to favorites'}
                hitSlop={12}
                style={styles.headerButton}
              >
                <Text style={[styles.star, saved && styles.starOn]}>{saved ? '★' : '☆'}</Text>
              </Pressable>
              <ThemeToggle />
            </View>
          ),
        }}
      />

      {renderer === 'html' ? (
        <WebView
          // Remount on theme or start change so the injection re-runs.
          key={`html-${theme}-${startFraction ?? 'none'}`}
          source={htmlSource}
          injectedJavaScriptBeforeContentLoaded={injected}
          originWhitelist={['*']}
          startInLoadingState
          setSupportMultipleWindows={false}
          scrollEnabled
          bounces={false}
          overScrollMode="never"
          onMessage={onMessage}
          // A 404 means arXiv has no HTML for this paper: that is the PDF case.
          onHttpError={(event) => {
            if (event.nativeEvent.statusCode >= 400) setRenderer('pdf');
          }}
          onError={() => setRenderer('pdf')}
          renderLoading={() => (
            <View style={styles.loading}>
              <ActivityIndicator color={palette.accent} />
            </View>
          )}
          style={styles.webview}
        />
      ) : (
        <WebView
          key={`pdf-${theme}`}
          source={pdfSource}
          originWhitelist={['*']}
          startInLoadingState
          setSupportMultipleWindows={false}
          scrollEnabled
          bounces={false}
          overScrollMode="never"
          onMessage={onMessage}
          javaScriptEnabled
          renderLoading={() => (
            <View style={styles.loading}>
              <ActivityIndicator color={palette.accent} />
            </View>
          )}
          style={styles.webview}
        />
      )}
    </View>
  );
}

const makeStyles = (p: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: p.bg },
    webview: { flex: 1, backgroundColor: p.bg },
    loading: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: p.bg,
    },
    headerRight: { flexDirection: 'row', alignItems: 'center' },
    headerButton: { paddingHorizontal: 6, paddingVertical: 4 },
    star: { fontSize: 20, color: p.dim },
    starOn: { color: p.accent },
  });
