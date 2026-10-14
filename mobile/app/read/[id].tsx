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
 * topmost visible block (or page, for a PDF).
 *
 * Two things here are deliberately not done by remounting the WebView:
 *
 *  - **Theme.** Changing colour injects `__dpTheme` into the loaded page. Remounting to
 *    recolour reloads the article, which is why toggling the theme used to throw the reader
 *    back to wherever the paper had originally been opened.
 *  - **Restore.** The page announces 'ready' and the app then drives the restore and checks
 *    where it landed, retrying if that is not where it asked for. The page's own timer can
 *    fire while the document is still blank.
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
import { RESTORE_JS, buildReaderScript, themeJs } from '../../src/readerScript';
import { useTheme, type Palette } from '../../src/theme';
import type { PaperItem } from '../../src/types';

const ARXIV_HTML = 'https://arxiv.org/html/';
const ARXIV_PDF = 'https://arxiv.org/pdf/';

/** How far off the requested position we tolerate before trying again. */
const RESTORE_TOLERANCE = 0.02;
const MAX_RESTORE_TRIES = 3;

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
   * changing it would remount the page mid-read.
   */
  const [initialSpot, setInitialSpot] = useState<ReadingSpot | null>(null);
  /** Whether there is somewhere to return to, for the header button. Updated freely. */
  const [hasSpot, setHasSpot] = useState(false);
  const [meta, setMeta] = useState<PaperItem | null>(null);

  /**
   * Whether the saved position has been read yet.
   *
   * The WebView must not mount before it has. It used to: the position is read in an effect,
   * which runs after the first render where storage is ready, so the WebView mounted with no
   * position and was then remounted by its key changing — fetching the article from arXiv
   * twice, and applying the restore only on the second, slower load.
   */
  const [spotLoaded, setSpotLoaded] = useState(false);

  /** What we are trying to land on, and how many times we have tried. */
  const target = useRef<ReadingSpot | null>(null);
  const tries = useRef(0);

  /** Which paper the state above belongs to, so a second paper re-reads rather than reuses. */
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!ready || loadedFor.current === id) return;
    loadedFor.current = id;
    const stored = positionFor(id);
    setInitialSpot(stored);
    setHasSpot(isUsableSpot(stored));
    target.current = isUsableSpot(stored) ? stored : null;
    setMeta(paperMeta(id));
    setSpotLoaded(true);
  }, [ready, id, positionFor, paperMeta]);

  // Recolour the loaded page. Never a remount: that would reload the article.
  useEffect(() => {
    webviewRef.current?.injectJavaScript(themeJs(theme));
  }, [theme]);

  // If the paper has never been on screen there is no cached title. Ask arXiv once so the
  // header and any saved entry show a real name rather than "2610.14091".
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

  // Repair a saved entry whose metadata was not known when it was saved.
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

  const askRestore = useCallback(() => {
    webviewRef.current?.injectJavaScript(RESTORE_JS);
  }, []);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let msg: { type?: string; fraction?: number; anchor?: number };
      try {
        msg = JSON.parse(event.nativeEvent.data);
      } catch {
        return; // A malformed message is not worth interrupting reading for.
      }

      if (msg.type === 'position' && typeof msg.fraction === 'number') {
        const next = { fraction: msg.fraction, anchor: msg.anchor ?? -1 };
        rememberPosition(id, next);
        // Only the button's enabled state changes. `initialSpot` must not, or the WebView
        // remounts on every scroll report.
        setHasSpot(isUsableSpot(next));
        return;
      }

      if (msg.type === 'ready') {
        // The document is up. Re-assert the theme (a mid-load change would otherwise have
        // used whichever value the injected script was built with) and drive the restore.
        webviewRef.current?.injectJavaScript(themeJs(theme));
        if (target.current) {
          tries.current = 0;
          askRestore();
        }
        return;
      }

      if (msg.type === 'restored') {
        const want = target.current;
        if (!want || typeof msg.fraction !== 'number') return;
        const off = Math.abs(msg.fraction - want.fraction);
        // Closed loop: the page reports where it actually landed, so we can tell the
        // difference between "restored" and "asked to restore".
        if (off > RESTORE_TOLERANCE && tries.current < MAX_RESTORE_TRIES) {
          tries.current += 1;
          setTimeout(askRestore, 700);
        }
      }
    },
    [id, rememberPosition, theme, askRestore],
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

  // Wait for storage, and for the saved position, so the first paint already knows where to
  // scroll and the article is fetched once rather than twice.
  if (!ready || !spotLoaded) {
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
                onPress={() => {
                  tries.current = 0;
                  askRestore();
                }}
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
          // Keyed on the initial position only — never on the theme, which would reload the
          // article and lose the reader's place.
          key={`html-${initialSpot?.anchor ?? 'n'}-${initialSpot ? Math.round(initialSpot.fraction * 1000) : 'n'}`}
          source={htmlSource}
          injectedJavaScriptBeforeContentLoaded={injected}
          originWhitelist={['*']}
          startInLoadingState
          setSupportMultipleWindows={false}
          scrollEnabled
          bounces={false}
          overScrollMode="never"
          onMessage={onMessage}
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
          key={`pdf-${id}`}
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
