import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

export default function RootLayout() {
  return (
    <>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: '#16181c' },
          headerTintColor: '#e6e6e6',
          contentStyle: { backgroundColor: '#16181c' },
        }}
      >
        <Stack.Screen name="index" options={{ title: "Today's Papers" }} />
        <Stack.Screen name="read/[id]" options={{ title: 'Reading' }} />
      </Stack>
    </>
  );
}
