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
 * Position is { fraction, anchor }: how far through the document, plus the index of the
 * topmost visible block (or page, for a PDF). The fraction alone drifts because lazy figures
 * keep growing the document after load.
 *
 * Restore happens two ways. Automatically, best-effort, on open — the script retries until
 * the page stops growing rather than for a fixed count, because it runs before the document
 * exists. And explicitly, from the button in the header, which asks the already-loaded page
 * to scroll and is the dependable path.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { fetchArxivById } from '../../src/arxiv';
import { ThemeToggle } from '../../src/components/ThemeToggle';
import { needsRepair, useLibrary, type ReadingSpot } from '../../src/library';
import { pdfViewerHtml } from '../../src/pdfViewer';
import { READER_CSS } from '../../src/platform/readerCss.generated';
import { RESTORE_JS, buildReaderScript } from '../../src/readerScript';
import { useTheme, type Palette } from '../../src/theme';
import type { PaperItem } from '../../src/types';

const ARXIV_HTML = 'https://arxiv.org/html/';
const ARXIV_PDF = 'https://arxiv.org/pdf/';

/** A position at the very top is not somewhere to go back to. */
function isUsableSpot(s: ReadingSpot | null): boolean {
  return !!s && (s.anchor >= 0 || s.fraction > 0.005);
}

export default function ReaderScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  // Old-style ids arrive percent-encoded (math.GT%2F0309136) so the route stays one segment.
  const id = decodeURIComponent(String(params.id ?? ''));
  const { theme, palette } = useTheme();
  const {
    ready,
    favorites,
    positionFor,
    rememberPosition,
    rememberPaper,
    paperMeta,
    updateFavorite,
    isFavorite,
    toggleFavorite,
  } = useLibrary();

  const webviewRef = useRef<WebView>(null);
  const [renderer, setRenderer] = useState<'html' | 'pdf'>('html');

  /**
   * The position the WebView was created with.
   *
   * Deliberately NOT updated as the reader scrolls: it is part of the WebView's `key`, so
   * changing it would remount the page mid-read and throw the reader back to the top every
   * time a position was reported.
   */
  const [initialSpot, setInitialSpot] = useState<ReadingSpot | null>(null);
  /** Whether there is somewhere to return to, for the header button. Updated freely. */
  const [hasSpot, setHasSpot] = useState(false);

  const [meta, setMeta] = useState<PaperItem | null>(null);

  const startedRef = useRef(false);
  useEffect(() => {
    if (!ready || startedRef.current) return;
    startedRef.current = true;
    const stored = positionFor(id);
    setInitialSpot(stored);
    setHasSpot(isUsableSpot(stored));
    setMeta(paperMeta(id));
  }, [ready, id, positionFor, paperMeta]);

  // If the paper has never been on screen there is no cached title — a cold open from a
  // pasted id, a link, or the paper of the day. Ask arXiv once so the header and any saved
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
  const entry = favorites.find((f) => f.id === id);

  // Repair a saved entry whose metadata was not known when it was saved. Without this the
  // paper stays in the Saved tab as a bare id, and toggling it would simply delete it.
  useEffect(() => {
    if (!meta || !entry || !needsRepair(entry)) return;
    updateFavorite(id, {
      title: meta.title,
      abstract: meta.abstract,
      category: meta.category,
      authors: meta.authors,
      published: meta.published,
    });
  }, [meta, entry, id, updateFavorite]);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      try {
        const msg = JSON.parse(event.nativeEvent.data) as {
          type: string;
          fraction?: number;
          anchor?: number;
        };
        if (msg.type === 'position' && typeof msg.fraction === 'number') {
          const next = { fraction: msg.fraction, anchor: msg.anchor ?? -1 };
          rememberPosition(id, next);
          // Only the button's enabled state changes. `initialSpot` must not, or the WebView
          // remounts on every scroll report.
          setHasSpot(isUsableSpot(next));
        }
      } catch {
        // A malformed message from the page is not worth interrupting reading for.
      }
    },
    [id, rememberPosition],
  );

  // The script is a module so it can be exercised against real arXiv HTML in a browser;
  // see mobile/harness/check_restore.py.
  const injected = useMemo(
    () => buildReaderScript({ css: READER_CSS, theme, spot: initialSpot }),
    [theme, initialSpot],
  );

  const pdfSource = useMemo(
    () => ({ html: pdfViewerHtml({ url: `${ARXIV_PDF}${id}`, theme, start: initialSpot }) }),
    [id, theme, initialSpot],
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

  const headerTitle = meta?.title
    ? meta.title.length > 30
      ? `${meta.title.slice(0, 29)}…`
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
                onPress={() => webviewRef.current?.injectJavaScript(RESTORE_JS)}
                disabled={!hasSpot}
                testID="reader-restore"
                accessibilityRole="button"
                accessibilityLabel={
                  hasSpot ? 'Return to where you stopped reading' : 'No saved position yet'
                }
                hitSlop={12}
                style={styles.headerButton}
              >
                <Text style={[styles.glyph, hasSpot && styles.glyphOn]}>⟲</Text>
              </Pressable>

              <Pressable
                onPress={() =>
                  toggleFavorite({
                    id,
                    // Real metadata when we have it. The id is only ever a last resort, and
                    // the Saved tab repairs the entry once the lookup returns.
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
                <Text style={[styles.glyph, saved && styles.glyphOn]}>
                  {saved ? '★' : '☆'}
                </Text>
              </Pressable>

              <ThemeToggle />
            </View>
          ),
        }}
      />

      {renderer === 'html' ? (
        <WebView
          ref={webviewRef}
          // Remount on theme or the initial position only — never on scroll.
          key={`html-${theme}-${initialSpot?.anchor ?? 'n'}-${initialSpot ? Math.round(initialSpot.fraction * 1000) : 'n'}`}
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
          ref={webviewRef}
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
    glyph: { fontSize: 20, color: p.dim },
    glyphOn: { color: p.accent },
  });
