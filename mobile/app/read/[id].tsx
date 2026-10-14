/**
 * Reader screen: arXiv HTML full text, reflowed for a phone.
 *
 * The WebView loads arXiv's HTML directly rather than fetching it in JS and injecting the
 * markup. Two reasons: fetching cross-origin from the app would hit CORS, and top-level
 * navigation in a WebView does not. Relative figure URLs also keep resolving against
 * arxiv.org without needing a <base> tag.
 *
 * A WebView here is a deliberate, narrow choice — one screen, not the whole app. The markup
 * is deeply nested HTML with tables and native MathML, and parsing that into React Native
 * components would be a large amount of work with no good answer for math.
 *
 * The stylesheet is generated from reader/static/reader.css and verified against a real
 * 390x844 viewport: zero page-level horizontal overflow across six papers from six
 * categories.
 */

import { useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { READER_CSS } from '../../src/platform/readerCss.generated';
import { useTheme } from '../../src/theme';

const ARXIV_HTML = 'https://arxiv.org/html/';

export default function ReaderScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  // Old-style ids arrive percent-encoded (math.GT%2F0309136) so the route stays one segment.
  const id = decodeURIComponent(String(params.id ?? ''));
  const [failed, setFailed] = useState(false);
  const { theme, palette } = useTheme();

  const uri = `${ARXIV_HTML}${id}`;
  const pdfUri = `https://arxiv.org/pdf/${id}`;

  /**
   * Applied before first paint so arXiv's own desktop CSS never flashes. `document.head`
   * may not exist yet at this point, hence the documentElement fallback.
   *
   * The theme is set explicitly as `data-theme`. The stylesheet no longer contains a
   * `prefers-color-scheme` rule, deliberately: following the system meant the article could
   * render dark inside a light app (or the reverse), and there was no way for the user to
   * override it.
   */
  const injected = useMemo(
    () => `
      (function () {
        var css = ${JSON.stringify(READER_CSS)};
        var theme = ${JSON.stringify(theme)};
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
        true;
      })();
    `,
    [theme],
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        screen: { flex: 1, backgroundColor: palette.bg },
        webview: { flex: 1, backgroundColor: palette.bg },
        loading: {
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          alignItems: 'center',
          justifyContent: 'center',
        },
        fallback: {
          flex: 1,
          backgroundColor: palette.bg,
          padding: 24,
          gap: 12,
          justifyContent: 'center',
        },
        fallbackTitle: { color: palette.text, fontSize: 20, fontWeight: '600' },
        fallbackBody: { color: palette.dim, fontSize: 14, lineHeight: 20 },
        button: {
          alignSelf: 'flex-start',
          marginTop: 8,
          paddingHorizontal: 16,
          paddingVertical: 10,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: palette.border,
        },
        buttonText: { color: palette.accent, fontSize: 14 },
      }),
    [palette],
  );

  if (failed) {
    // ~4% of arXiv papers have no HTML rendering and need the PDF fallback.
    return (
      <View style={styles.fallback}>
        <Text style={styles.fallbackTitle}>No HTML full text</Text>
        <Text style={styles.fallbackBody}>
          {id} has no rendered HTML on arXiv. This is the ~4% of papers that need the PDF
          fallback.
        </Text>
        <Pressable style={styles.button} onPress={() => void Linking.openURL(pdfUri)}>
          <Text style={styles.buttonText}>Open PDF</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <WebView
        // Remounting on a theme change is what re-runs the injection; the WebView caches
        // the page otherwise and the article would keep the old colours.
        key={theme}
        source={{ uri }}
        injectedJavaScriptBeforeContentLoaded={injected}
        originWhitelist={['*']}
        startInLoadingState
        setSupportMultipleWindows={false}
        // Overflow is handled in CSS, but these stop the platform adding its own sideways
        // rubber-banding on top of it.
        scrollEnabled
        bounces={false}
        overScrollMode="never"
        onError={() => setFailed(true)}
        onHttpError={(event) => {
          if (event.nativeEvent.statusCode >= 400) setFailed(true);
        }}
        renderLoading={() => (
          <View style={styles.loading}>
            <ActivityIndicator color={palette.accent} />
          </View>
        )}
        style={styles.webview}
      />
    </View>
  );
}
