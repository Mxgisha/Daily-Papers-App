# Building and publishing the APK

The app is an Expo project, so there is no `android/` directory to maintain — the native
project is generated at build time from `app.json`. Two ways to produce an APK.

---

## Option A — EAS Build (no Android SDK needed)

A cloud build. `mobile/eas.json` is already configured: the `preview` profile emits an
**APK**, the `production` profile emits an **AAB** for the Play Store.

```bash
npm install -g eas-cli
eas login                       # free Expo account
cd mobile
eas build:configure             # first time only; registers the project
eas build --platform android --profile preview
```

The first build asks whether to generate a keystore — let EAS generate and store it. The build
takes 10–20 minutes and finishes with a URL and a QR code.

**`app.json` already carries an `extra.eas.projectId`**, written by Expo tooling. If the build
fails with "project not found", run `eas build:configure` once — it re-registers the project
against your account and rewrites that id. Commit whatever it writes; builds fail without it,
and it is easy to miss.

## Option B — local build

Needs the Android SDK and **JDK 17** (not newer; the Android Gradle Plugin rejects it).

```bash
cd mobile
npx expo prebuild --platform android
cd android
./gradlew assembleDebug
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`.

Use `assembleDebug`, not `assembleRelease` — a release APK needs a signing keystore, and an
unsigned one will not install. For testing, debug is fine.

---

## Installing on a phone

1. Settings → About phone → tap **Build number** seven times.
2. Settings → System → Developer options → **USB debugging**.
3. Either `adb install app.apk` over USB, or copy the APK across and tap it, allowing
   "install unknown apps" for the file manager.

---

## Publishing it as a GitHub Release

The APK belongs on the **Releases** page, not in the repository. A 60 MB binary committed to
git is permanent — every clone carries it forever. A release asset is attached to one tag and
can be replaced.

### 1. Bump the version

Both numbers, in `mobile/app.json`:

```json
"version": "0.2.0",
"android": { "versionCode": 2 }
```

Android refuses to install over an existing app with the same or a lower `versionCode`.

### 2. Build

```bash
cd mobile
eas build --platform android --profile preview
```

### 3. Create the release

On GitHub: **Releases → Draft a new release**.

- **Tag:** `v0.2.0` (create it on publish)
- **Title:** `Daily Papers v0.2.0`
- **Description:** what changed, and what to look at — a short list, not the full log
- **Attach:** the `.apk` downloaded from the EAS build page

Then the README's link works as
`https://github.com/<owner>/<repo>/releases/latest` and always points at the newest build.

### 4. Or from the command line

```bash
gh release create v0.2.0 ./app-preview.apk \
  --title "Daily Papers v0.2.0" \
  --notes "Text size, find in paper, offline text, daily reminder, diagnostics."
```

---

## Notes

- **The bundle identifier is `app.dailypapers`.** Fine for side-loading. It must be globally
  unique if the app is ever submitted to Play.
- **`app.json` sets `userInterfaceStyle: automatic`**, and the app forces a scheme at runtime
  with `Appearance.setColorScheme`. `expo-system-ui` is installed because without it that
  setting is ignored on Android.
- **Prebuild adds `SYSTEM_ALERT_WINDOW`, `READ/WRITE_EXTERNAL_STORAGE` and `VIBRATE`** from
  Expo's defaults. Harmless for a side-loaded test build; trim them before a store submission,
  because `SYSTEM_ALERT_WINDOW` is a sensitive permission on Play.
