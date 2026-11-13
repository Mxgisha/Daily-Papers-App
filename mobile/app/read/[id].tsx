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
 * Position is { fraction, anchor }. Restore is belt-and-braces: the page retries until it
 * stops growing, the app verifies where it actually landed and retries, and the header button
 * does it on demand.
 *
 * Everything that changes the page after load — theme, text size, highlights — is injected
 * rather than triggering a remount. A remount reloads the article and loses the reader's
 * place, which is how theming used to behave.
 *
 * If a paper has been saved for offline reading, the saved HTML is used instead of fetching
 * the live page, so "saved" actually means something on a train. Its figures still come from
 * arXiv through the injected <base>, so it degrades to text-only when there is no connection.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { fetchArxivById } from '../../src/arxiv';
import { fetchArticleHtml } from '../../src/articleHtml';
import { ThemeToggle } from '../../src/components/ThemeToggle';
import { needsRepair, useLibrary, type ReadingSpot } from '../../src/library';
import { readArticle, removeArticle, saveArticle } from '../../src/offline';
import { pdfViewerHtml } from '../../src/pdfViewer';
import { READER_CSS } from '../../src/platform/readerCss.generated';
import {
  FIND_CLEAR_JS,
  FIND_JS,
  RESTORE_JS,
  buildReaderScript,
  ensureReaderCssJs,
  setTextSizeJs,
  themeJs,
} from '../../src/readerScript';
import { useSettings } from '../../src/settings';
import { useTheme, type Palette } from '../../src/theme';
import type { PaperItem } from '../../src/types';

const ARXIV_HTML = 'https://arxiv.org/html/';
const ARXIV_PDF = 'https://arxiv.org/pdf/';
const ARXIV_ABS = 'https://arxiv.org/abs/';

const RESTORE_TOLERANCE = 0.02;
const MAX_RESTORE_TRIES = 3;

function isUsableSpot(s: ReadingSpot | null): boolean {
  return !!s && (s.anchor >= 0 || s.fraction > 0.005);
}

type OfflineState = 'unknown' | 'saved' | 'none';

export default function ReaderScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = decodeURIComponent(String(params.id ?? ''));
  const { theme, palette } = useTheme();
  const { textSizePx, cycleTextScale } = useSettings();
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
    history,
    recordOpen,
    updateHistory,
    markFinished,
  } = useLibrary();

  const webviewRef = useRef<WebView>(null);
  const [renderer, setRenderer] = useState<'html' | 'pdf'>('html');
  const [initialSpot, setInitialSpot] = useState<ReadingSpot | null>(null);
  const [hasSpot, setHasSpot] = useState(false);
  const [meta, setMeta] = useState<PaperItem | null>(null);
  const [spotLoaded, setSpotLoaded] = useState(false);

  const [menuOpen, setMenuOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findTerm, setFindTerm] = useState('');
  const [findInfo, setFindInfo] = useState<{ count: number; index: number } | null>(null);
  const [offlineState, setOfflineState] = useState<OfflineState>('unknown');
  const [offlineHtml, setOfflineHtml] = useState<string | null>(null);
  /** The article fetched and rewritten by us, so figures can be lazy. Null means use the URL. */
  const [liveHtml, setLiveHtml] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const target = useRef<ReadingSpot | null>(null);
  const tries = useRef(0);
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

  // Same rule for text size.
  useEffect(() => {
    webviewRef.current?.injectJavaScript(setTextSizeJs(textSizePx));
  }, [textSizePx]);

  // Offline copy, if there is one.
  useEffect(() => {
    let alive = true;
    (async () => {
      const html = await readArticle(id);
      if (!alive) return;
      setOfflineHtml(html);
      setOfflineState(html ? 'saved' : 'none');
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  /**
   * Fetch and prepare the article ourselves.
   *
   * Loading arXiv's URL directly lets the WebView stream, but also lets the preload scanner
   * start every figure before any script runs — and `loading="lazy"` only counts if it is in
   * the markup at that moment. See src/articleHtml.ts.
   *
   * The fallback matters more than the optimisation: if the fetch fails, we load the URL and
   * behave exactly as before.
   */
  useEffect(() => {
    if (offlineHtml) return;
    let alive = true;
    (async () => {
      const html = await fetchArticleHtml(id);
      if (alive && html) setLiveHtml(html);
    })();
    return () => {
      alive = false;
    };
  }, [id, offlineHtml]);

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
  const finished = !!history.find((h) => h.id === id)?.finishedAt;

  const recordedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !spotLoaded || recordedFor.current === id) return;
    recordedFor.current = id;
    recordOpen(meta ?? { id, title: id, abstract: '', category: '', published: null, authors: [] });
  }, [ready, spotLoaded, id, meta, recordOpen]);

  useEffect(() => {
    if (!meta) return;
    updateHistory(id, {
      title: meta.title,
      abstract: meta.abstract,
      category: meta.category,
      authors: meta.authors,
      published: meta.published,
    });
  }, [meta, id, updateHistory]);

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

  const runFind = useCallback((term: string) => {
    if (!term.trim()) {
      webviewRef.current?.injectJavaScript(FIND_CLEAR_JS);
      setFindInfo(null);
      return;
    }
    webviewRef.current?.injectJavaScript(`window.__dpFind(${JSON.stringify(term)}); true;`);
  }, []);

  const stepFind = useCallback((delta: number) => {
    webviewRef.current?.injectJavaScript(
      `window.__dpFindStep(${JSON.stringify(delta)}); true;`,
    );
  }, []);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let msg: {
        type?: string;
        fraction?: number;
        anchor?: number;
        count?: number;
        index?: number;
      };
      try {
        msg = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }

      if (msg.type === 'position' && typeof msg.fraction === 'number') {
        const next = { fraction: msg.fraction, anchor: msg.anchor ?? -1 };
        rememberPosition(id, next);
        setHasSpot(isUsableSpot(next));
        return;
      }

      if (msg.type === 'ready') {
        // A page that just loaded may have missed the before-load injection entirely.
        webviewRef.current?.injectJavaScript(themeJs(theme));
        webviewRef.current?.injectJavaScript(setTextSizeJs(textSizePx));
        webviewRef.current?.injectJavaScript(FIND_JS);
        if (target.current) {
          tries.current = 0;
          askRestore();
        }
        return;
      }

      if (msg.type === 'find' && typeof msg.count === 'number') {
        setFindInfo({ count: msg.count, index: msg.index ?? -1 });
        return;
      }

      if (msg.type === 'restored') {
        const want = target.current;
        if (!want || typeof msg.fraction !== 'number') return;
        const off = Math.abs(msg.fraction - want.fraction);
        if (off > RESTORE_TOLERANCE && tries.current < MAX_RESTORE_TRIES) {
          tries.current += 1;
          setTimeout(askRestore, 700);
        }
      }
    },
    [id, rememberPosition, theme, textSizePx, askRestore],
  );

  const injected = useMemo(
    () => buildReaderScript({ css: READER_CSS, theme, spot: initialSpot }),
    [theme, initialSpot],
  );

  const pdfSource = useMemo(
    () => ({ html: pdfViewerHtml({ url: `${ARXIV_PDF}${id}`, theme, start: initialSpot }) }),
    [id, theme, initialSpot],
  );

  const htmlSource = useMemo(() => {
    // Offline copy first (it is the whole point), then our prepared copy, then the bare URL
    // as the fallback that behaves exactly as the app did before.
    if (offlineHtml) return { html: offlineHtml };
    if (liveHtml) return { html: liveHtml };
    return { uri: `${ARXIV_HTML}${id}` };
  }, [offlineHtml, liveHtml, id]);

  const styles = useMemo(() => makeStyles(palette), [palette]);

  const share = useCallback(() => {
    setMenuOpen(false);
    void Share.share({
      message: `${meta?.title ?? id}\n${ARXIV_ABS}${id}`,
      title: meta?.title ?? id,
    });
  }, [id, meta]);

  const toggleOffline = useCallback(async () => {
    setMenuOpen(false);
    setBusy(true);
    try {
      if (offlineState === 'saved') {
        await removeArticle(id);
        setOfflineHtml(null);
        setOfflineState('none');
      } else {
        const result = await saveArticle(id);
        if (result.ok) {
          setOfflineHtml(await readArticle(id));
          setOfflineState('saved');
        } else {
          setOfflineState('none');
          void Share.share({ message: `Could not save ${id}: ${result.error}` });
        }
      }
    } finally {
      setBusy(false);
    }
  }, [id, offlineState]);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindTerm('');
    setFindInfo(null);
    webviewRef.current?.injectJavaScript(FIND_CLEAR_JS);
  }, []);

  if (!ready || !spotLoaded || offlineState === 'unknown') {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={palette.accent} />
      </View>
    );
  }

  const headerTitle = meta?.title
    ? meta.title.length > 26
      ? `${meta.title.slice(0, 25)}…`
      : meta.title
    : 'Reading';

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          title: headerTitle,
          // The drawer control belongs on the list screens; here the useful left control is
          // the way back, which this screen is the only one to have.
          headerLeft: undefined,
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
                hitSlop={10}
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
                hitSlop={10}
                style={styles.headerButton}
              >
                <Text style={[styles.glyph, saved && styles.glyphOn]}>{saved ? '★' : '☆'}</Text>
              </Pressable>

              <Pressable
                onPress={() => markFinished(id, !finished)}
                testID="reader-finished"
                accessibilityRole="button"
                accessibilityState={{ selected: finished }}
                accessibilityLabel={finished ? 'Mark as not finished' : 'Mark as finished reading'}
                hitSlop={10}
                style={styles.headerButton}
              >
                <Text style={[styles.glyph, finished && styles.glyphOn]}>✓</Text>
              </Pressable>

              <Pressable
                onPress={cycleTextScale}
                testID="reader-textsize"
                accessibilityRole="button"
                accessibilityLabel="Change text size"
                hitSlop={10}
                style={styles.headerButton}
              >
                <Text style={styles.aa}>Aa</Text>
              </Pressable>

              <Pressable
                onPress={() => setMenuOpen(true)}
                testID="reader-menu"
                accessibilityRole="button"
                accessibilityLabel="More actions"
                hitSlop={10}
                style={styles.headerButton}
              >
                <Text style={styles.glyph}>⋯</Text>
              </Pressable>
            </View>
          ),
        }}
      />

      {findOpen && (
        <View style={styles.findBar}>
          <TextInput
            value={findTerm}
            onChangeText={(t) => {
              setFindTerm(t);
              runFind(t);
            }}
            placeholder="Find in paper"
            placeholderTextColor={palette.dim}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            testID="find-input"
            style={styles.findInput}
          />
          <Text style={styles.findCount}>
            {findInfo === null
              ? ''
              : findInfo.count === 0
                ? 'none'
                : `${findInfo.index + 1}/${findInfo.count}`}
          </Text>
          <Pressable onPress={() => stepFind(-1)} hitSlop={10} style={styles.findButton}>
            <Text style={styles.findButtonText}>‹</Text>
          </Pressable>
          <Pressable onPress={() => stepFind(1)} hitSlop={10} style={styles.findButton}>
            <Text style={styles.findButtonText}>›</Text>
          </Pressable>
          <Pressable onPress={closeFind} hitSlop={10} style={styles.findButton}>
            <Text style={styles.findButtonText}>✕</Text>
          </Pressable>
        </View>
      )}

      {renderer === 'html' ? (
        <WebView
          ref={webviewRef}
          key={`html-${offlineHtml ? 'off' : liveHtml ? 'prep' : 'net'}-${initialSpot?.anchor ?? 'n'}-${initialSpot ? Math.round(initialSpot.fraction * 1000) : 'n'}`}
          source={htmlSource}
          injectedJavaScriptBeforeContentLoaded={injected}
          injectedJavaScript={
            ensureReaderCssJs(READER_CSS, theme) + setTextSizeJs(textSizePx) + FIND_JS
          }
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

      {busy && (
        <View style={styles.busy}>
          <ActivityIndicator color={palette.accent} />
        </View>
      )}

      <Modal
        visible={menuOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setMenuOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <SheetRow
              label="Find in paper"
              onPress={() => {
                setMenuOpen(false);
                setFindOpen(true);
              }}
              styles={styles}
            />
            <SheetRow label="Share" onPress={share} styles={styles} />
            <SheetRow
              label={offlineState === 'saved' ? 'Remove offline copy' : 'Save for offline'}
              onPress={() => void toggleOffline()}
              styles={styles}
            />
            <View style={styles.sheetDivider} />
            <View style={styles.sheetTheme}>
              <Text style={styles.sheetLabel}>Theme</Text>
              <ThemeToggle />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function SheetRow({
  label,
  onPress,
  styles,
}: {
  label: string;
  onPress: () => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <Pressable onPress={onPress} style={styles.sheetRow} accessibilityRole="button">
      <Text style={styles.sheetLabel}>{label}</Text>
    </Pressable>
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
    headerButton: { paddingHorizontal: 5, paddingVertical: 4 },
    glyph: { fontSize: 19, color: p.dim },
    glyphOn: { color: p.accent },
    aa: { fontSize: 15, fontWeight: '700', color: p.dim },
    findBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 7,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: p.border,
      backgroundColor: p.headerBg,
    },
    findInput: {
      flex: 1,
      color: p.text,
      backgroundColor: p.inputBg,
      borderRadius: 7,
      paddingHorizontal: 10,
      paddingVertical: 7,
      fontSize: 14,
    },
    findCount: { color: p.dim, fontSize: 12, minWidth: 42, textAlign: 'center' },
    findButton: { paddingHorizontal: 7, paddingVertical: 2 },
    findButtonText: { color: p.accent, fontSize: 19 },
    busy: {
      position: 'absolute',
      bottom: 26,
      alignSelf: 'center',
      backgroundColor: p.headerBg,
      padding: 12,
      borderRadius: 24,
    },
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
    sheet: {
      backgroundColor: p.headerBg,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      paddingVertical: 10,
      paddingBottom: 28,
    },
    sheetRow: { paddingHorizontal: 20, paddingVertical: 15 },
    sheetDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: p.border,
      marginVertical: 6,
    },
    sheetTheme: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 20,
      paddingVertical: 10,
    },
    sheetLabel: { color: p.text, fontSize: 16 },
  });
