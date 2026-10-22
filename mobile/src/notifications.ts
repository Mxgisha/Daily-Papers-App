/**
 * The daily reminder.
 *
 * A local scheduled notification — no server, no push token, no account. A seven-day test
 * only produces seven days of data if something asks you to read on day three.
 *
 * Android needs a channel before anything can be posted, and Android 13+ needs runtime
 * permission. Both are handled here so callers only deal with "on" and "off".
 */

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

const CHANNEL_ID = 'reminders';

/** Show the reminder even when the app is in the foreground. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Daily reminder',
    importance: Notifications.AndroidImportance.DEFAULT,
    description: 'A nudge to read a paper.',
  });
}

export type PermissionOutcome = 'granted' | 'denied' | 'unsupported';

export async function requestPermission(): Promise<PermissionOutcome> {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return 'granted';
    // `canAskAgain` is false once the user has refused twice; asking again does nothing and
    // we should point them at system settings instead.
    if (!current.canAskAgain) return 'denied';
    const asked = await Notifications.requestPermissionsAsync();
    return asked.granted ? 'granted' : 'denied';
  } catch {
    return 'unsupported';
  }
}

/** Replace any existing reminder with one at `hour` every day. */
export async function scheduleDaily(hour: number): Promise<boolean> {
  try {
    await ensureChannel();
    await Notifications.cancelAllScheduledNotificationsAsync();
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Daily Papers',
        body: 'A paper is waiting. Pick one up where you left off.',
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        hour,
        minute: 0,
        channelId: CHANNEL_ID,
      },
    });
    return true;
  } catch {
    return false;
  }
}

export async function cancelDaily(): Promise<void> {
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
  } catch {
    // Nothing scheduled is not an error.
  }
}

/** How many reminders are scheduled — used by the diagnostics screen to prove it took. */
export async function scheduledCount(): Promise<number> {
  try {
    return (await Notifications.getAllScheduledNotificationsAsync()).length;
  } catch {
    return 0;
  }
}
