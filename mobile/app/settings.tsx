/**
 * Settings and diagnostics.
 *
 * Two things that belong together because they answer the same question: "what state is this
 * app in?". Settings change it, diagnostics report it — and during a week of testing on a
 * phone, being able to read the state out and paste it into a message is worth more than any
 * single feature.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';

import { useLibrary } from '../src/library';
import { cancelDaily, requestPermission, scheduleDaily, scheduledCount } from '../src/notifications';
import { listArticles } from '../src/offline';
import { TEXT_SIZE_LABELS, TEXT_SIZES, useSettings } from '../src/settings';
import { useTheme, type Palette } from '../src/theme';

/** Hours offered by the reminder control; cycled rather than a date picker. */
const REMINDER_HOURS = [8, 12, 18, 21];

export default function SettingsScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const { width, height } = useWindowDimensions();

  const { favorites, history, recentSearches, positionFor } = useLibrary();
  const { textScale, setTextScale, reminderHour, setReminderHour } = useSettings();

  const [offline, setOffline] = useState<string[] | null>(null);
  const [scheduled, setScheduled] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void listArticles().then((ids) => {
      if (alive) setOffline(ids);
    });
    void scheduledCount().then((n) => {
      if (alive) setScheduled(n);
    });
    return () => {
      alive = false;
    };
  }, []);

  const cycleReminder = useCallback(async () => {
    setBusy(true);
    try {
      const next =
        reminderHour === null
          ? REMINDER_HOURS[0]
          : REMINDER_HOURS[REMINDER_HOURS.indexOf(reminderHour) + 1] ?? null;

      if (next === null) {
        await cancelDaily();
        setReminderHour(null);
      } else {
        const permission = await requestPermission();
        if (permission !== 'granted') {
          // Leave it off rather than claim a reminder that cannot be delivered.
          await cancelDaily();
          setReminderHour(null);
        } else {
          const ok = await scheduleDaily(next);
          setReminderHour(ok ? next : null);
        }
      }
      setScheduled(await scheduledCount());
    } finally {
      setBusy(false);
    }
  }, [reminderHour, setReminderHour]);

  // Positions are not enumerable from the context, so count the papers in history that have
  // one — that is the number that actually matters and it needs no extra storage read.
  const withPosition = useMemo(
    () => history.filter((h) => positionFor(h.id) !== null).length,
    [history, positionFor],
  );

  const report = useMemo(
    () =>
      [
        `Daily Papers ${Constants.expoConfig?.version ?? '?'} (${Constants.expoConfig?.android?.versionCode ?? '?'})`,
        `device: ${Device.modelName ?? 'unknown'} / Android ${Platform.Version}`,
        `screen: ${Math.round(width)}x${Math.round(height)} @${Constants.deviceName ? '' : ''}${Platform.OS}`,
        `saved: ${favorites.length}  history: ${history.length}  positions: ${withPosition}`,
        `recent searches: ${recentSearches.length}  offline copies: ${offline?.length ?? 0}`,
        `text size: ${TEXT_SIZE_LABELS[textScale]}  reminder: ${reminderHour === null ? 'off' : `${reminderHour}:00`}  scheduled: ${scheduled ?? '?'}`,
      ].join('\n'),
    [favorites.length, history.length, withPosition, recentSearches.length, offline, textScale, reminderHour, scheduled, width, height],
  );

  const copyReport = useCallback(() => {
    void Share.share({ message: report });
  }, [report]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.section}>READING</Text>
      <View style={styles.card}>
        <Text style={styles.label}>Text size</Text>
        <View style={styles.segment}>
          {TEXT_SIZES.map((px, i) => {
            const active = i === textScale;
            return (
              <Pressable
                key={px}
                onPress={() => setTextScale(i)}
                testID={`text-size-${i}`}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                style={[styles.segmentItem, active && styles.segmentActive]}
              >
                <Text
                  style={[styles.segmentText, active && styles.segmentTextActive, { fontSize: px - 4 }]}
                >
                  {TEXT_SIZE_LABELS[i]}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.hint}>Applies to the article, not the app.</Text>
      </View>

      <Text style={styles.section}>DAILY REMINDER</Text>
      <Pressable style={styles.card} onPress={cycleReminder} disabled={busy} testID="reminder-row">
        <View style={styles.rowBetween}>
          <Text style={styles.label}>Remind me to read</Text>
          {busy ? (
            <ActivityIndicator size="small" color={palette.accent} />
          ) : (
            <Text style={styles.value}>
              {reminderHour === null ? 'Off' : `${String(reminderHour).padStart(2, '0')}:00`}
            </Text>
          )}
        </View>
        <Text style={styles.hint}>
          Tap to cycle: off, 08:00, 12:00, 18:00, 21:00. A local notification — nothing leaves
          the phone.
        </Text>
        {scheduled !== null && scheduled > 0 && (
          <Text style={styles.hint}>{scheduled} reminder scheduled.</Text>
        )}
      </Pressable>

      <Text style={styles.section}>OFFLINE</Text>
      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.label}>Saved for offline</Text>
          <Text style={styles.value}>{offline?.length ?? '…'}</Text>
        </View>
        <Text style={styles.hint}>
          Article text only. Figures load from arXiv when there is a connection.
        </Text>
      </View>

      <Text style={styles.section}>DIAGNOSTICS</Text>
      <View style={styles.card}>
        <Text style={styles.mono}>{report}</Text>
        <Pressable onPress={copyReport} style={styles.copy} testID="copy-diagnostics">
          <Text style={styles.copyText}>Copy / share this</Text>
        </Pressable>
      </View>

      <Text style={[styles.hint, styles.footer]}>
        Open a paper, read past the first screen, then check the ⟲ lights up. If it is dim,
        saving the position is what is broken — not restoring it.
      </Text>
    </ScrollView>
  );
}

const makeStyles = (p: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: p.bg },
    content: { padding: 16, paddingBottom: 40, gap: 8 },
    section: {
      color: p.dim,
      fontSize: 10,
      letterSpacing: 0.7,
      fontWeight: '700',
      marginTop: 10,
    },
    card: {
      backgroundColor: p.inputBg,
      borderWidth: 1,
      borderColor: p.border,
      borderRadius: 10,
      padding: 14,
      gap: 8,
    },
    label: { color: p.text, fontSize: 15, fontWeight: '600' },
    value: { color: p.accent, fontSize: 15, fontWeight: '600' },
    hint: { color: p.dim, fontSize: 12, lineHeight: 17 },
    rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    segment: { flexDirection: 'row', gap: 8 },
    segmentItem: {
      flex: 1,
      paddingVertical: 10,
      alignItems: 'center',
      borderRadius: 8,
      borderWidth: 1,
      borderColor: p.border,
      backgroundColor: p.chipBg,
    },
    segmentActive: { backgroundColor: p.chipActiveBg, borderColor: p.chipActiveBg },
    segmentText: { color: p.dim },
    segmentTextActive: { color: p.chipActiveText, fontWeight: '700' },
    mono: {
      color: p.text,
      fontSize: 11.5,
      lineHeight: 18,
      fontFamily: Platform.select({ android: 'monospace', ios: 'Menlo', default: 'monospace' }),
    },
    copy: { paddingTop: 6 },
    copyText: { color: p.accent, fontSize: 13, fontWeight: '600' },
    footer: { marginTop: 18, textAlign: 'center' },
  });
