/**
 * Reader screen.
 *
 * Two renderers behind one screen:
 *
 *   HTML  arXiv's own full text in a WebView, with the reader stylesheet injected before
 *         first paint so its desktop CSS never flashes.
 *   PDF   when arXiv has no HTML rendering (~4% of papers), PDF.js draws the PDF in the
 *         WebView. No native module, so this keeps working in Expo Go.
 *
 * Both report position as a fraction *plus* an anchor, where the anchor is the index of the
 * topmost visible block. The fraction alone drifted whenever the document changed height —
 * which lazy figures do continuously — so the anchor is what makes restore reliable.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { fetchArxivById } from '../../src/arxiv';
import { ThemeToggle } from '../../src/components/ThemeToggle';
import { useLibrary, type ReadingSpot } from '../../src/library';
import { pdfViewerHtml } from '../../src/pdfViewer';
import { READER_CSS } from '../../src/platform/readerCss.generated';
import { useTheme, type Palette } from '../../src/theme';
import type { PaperItem } from '../../src/types';

const ARXIV_HTML = 'https://arxiv.org/html/';
const ARXIV_PDF = 'https://arxiv.org/pdf/';

/**
 * Block-level elements used for anchoring. Deliberately generous: a paper that uses a
 * structure we did not list should still anchor to something, and an index into a longer
 * list is no less stable than an index into a shorter one.
 */
const BLOCK_SELECTOR = [
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

export default function ReaderScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  // Old-style ids arrive percent-encoded (math.GT%2F0309136) so the route stays one segment.
  const id = decodeURIComponent(String(params.id ?? ''));
  const { theme, palette } = useTheme();
  const {
    ready,
    positionFor,
    rememberPosition,
    rememberPaper,
    paperMeta,
    isFavorite,
    toggleFavorite,
  } = useLibrary();

  const [renderer, setRenderer] = useState<'html' | 'pdf'>('html');
  const [spot, setSpot] = useState<ReadingSpot | null>(null);
  const [meta, setMeta] = useState<PaperItem | null>(null);

  const startedRef = useRef(false);
  useEffect(() => {
    if (!ready || startedRef.current) return;
    startedRef.current = true;
    setSpot(positionFor(id));
    setMeta(paperMeta(id));
  }, [ready, id, positionFor, paperMeta]);

  // If the paper has never been on screen there is no cached title — a cold open from a
  // pasted id, a link, or the paper of the day. Ask arXiv once so the header and the saved
  // entry show a real name rather than "2610.14091".
  useEffect(() => {
    if (!ready || meta) return;
    let alive = true;
    fetchArxivById(id).then((result) => {
      if (!alive || !result) return;
      const item: PaperItem = {
        id: result.id,
        title: result.title,
        abstract: result.abstract,
        category: result.category,
        published: result.published ? result.published.slice(0, 10) : null,
        authors: result.authors,
      };
      setMeta(item);
      rememberPaper(item);
    });
    return () => {
      alive = false;
    };
  }, [ready, id, meta, rememberPaper]);

  const saved = isFavorite(id);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      try {
        const msg = JSON.parse(event.nativeEvent.data) as {
          type: string;
          fraction?: number;
          anchor?: number;
        };
        if (msg.type === 'position' && typeof msg.fraction === 'number') {
          rememberPosition(id, {
            fraction: msg.fraction,
            anchor: typeof msg.anchor === 'number' ? msg.anchor : -1,
          });
        }
      } catch {
        // A malformed message from the page is not worth interrupting reading for.
      }
    },
    [id, rememberPosition],
  );

  const injected = useMemo(() => {
    const startFraction = spot?.fraction ?? 0;
    const startAnchor = spot?.anchor ?? -1;
    return `
      (function () {
        var css = ${JSON.stringify(READER_CSS)};
        var theme = ${JSON.stringify(theme)};
        var startFraction = ${startFraction};
        var startAnchor = ${startAnchor};
        var BLOCK_SELECTOR = ${JSON.stringify(BLOCK_SELECTOR)};

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
            return;
          }
          var sp = span();
          if (startFraction > 0 && sp > 0) window.scrollTo(0, startFraction * sp);
        }

        // Restore repeatedly while the document settles. Lazy figures keep changing the
        // height long after load, so a single restored position drifts — which is why it
        // used to work sometimes and land in the wrong place other times. Stops as soon as
        // the reader touches the page.
        var userMoved = false;
        ['touchstart', 'wheel', 'keydown'].forEach(function (evt) {
          window.addEventListener(evt, function () { userMoved = true; }, { passive: true });
        });

        if (startAnchor >= 0 || startFraction > 0) {
          var tries = 0;
          (function settle() {
            if (userMoved || tries++ > 14) return;
            applyRestore();
            setTimeout(settle, 350);
          })();
        }

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
  }, [theme, spot]);

  const pdfSource = useMemo(
    () => ({
      html: pdfViewerHtml({
        url: `${ARXIV_PDF}${id}`,
        theme,
        start: spot,
      }),
    }),
    [id, theme, spot],
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

  // Long titles are unreadable in a nav bar; the header is a reminder, not the record.
  const headerTitle = meta?.title
    ? meta.title.length > 34
      ? `${meta.title.slice(0, 33)}…`
      : meta.title
    : 'Reading';

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          title: headerTitle,
          headerRight: () => (
            <View style={styles.headerRight}>
              <Pressable
                onPress={() =>
                  toggleFavorite({
                    id,
                    // Real metadata when we have it. The id is only ever a last resort, and
                    // when we fall back to it the title is at least honest about being one.
                    title: meta?.title ?? id,
                    category: meta?.category ?? '',
                    published: meta?.published ?? null,
                    authors: meta?.authors ?? [],
                    abstract: meta?.abstract ?? '',
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
          key={`html-${theme}-${spot?.anchor ?? 'n'}-${spot ? Math.round(spot.fraction * 1000) : 'n'}`}
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
