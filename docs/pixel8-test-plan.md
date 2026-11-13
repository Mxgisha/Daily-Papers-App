# Pixel 8 test run — features, cleanup, and the APK path

Prepared against `c854b3c` plus the changes in this commit.

---

## 1. What changed to get ready

### The codebase is now app-only

`mobile/` contains only what ships. The static-bundle loader and the on-device
recommendation pipeline were removed; their findings are recorded in `docs/findings.md`.
They were never reachable from a screen and never in the bundle, but they carried four
dependencies, and `expo-sqlite` alone is 76 MB on disk and a native module in the APK.

Removed from the app: `expo-sqlite`, `fzstd`, `js-sha256`.

**Kept, against first instinct:** `expo-linking` and `expo-constants`. A grep for direct
imports said both were unused. Removing them broke the build — `expo-router` imports
`expo-linking` in its `Unmatched` route, so it is a hard bundle-time dependency of the
framework even when our code never touches it. Removing a dependency requires checking
what the framework imports, not just what the app does.

`mobile/src` is now twelve modules, and `app/` imports eleven of them. The architecture
test fails the build if a screen reaches the off-path machinery or if any relative import
stops resolving.

### Build configuration

| | |
|---|---|
| `assets/icon.png` | 1024², three stacked bars on the app's own dark header colour |
| `assets/adaptive-icon.png` | Android foreground, mark inside the 66% safe zone |
| `assets/splash.png` | mark centred on `#16181c` |
| `eas.json` | `preview` profile builds an **APK**; `production` builds an **AAB** |
| `app.json` | icons wired, `versionCode: 1`, deprecated `edgeToEdgeEnabled` removed |
| `expo-system-ui` | added — without it `userInterfaceStyle` is ignored on Android, and theme switching has been the flakiest part of this app |

`expo prebuild --platform android` runs clean with no warnings. That validates the config
plugins and generates a real manifest, which is most of what a build failure would come from.

---

## 2. Features — built

All six are in. They are listed with what they actually do, because the point of the week is
to find out which of them earn their place.

### Reader

| Feature | What it does |
|---|---|
| **Text size** | `Aa` in the reader header cycles Small / Default / Large (16/18/21 px) and persists. It sets the stylesheet's own `--font-size` variable — no second stylesheet, no reload. Also settable in Settings. |
| **Find in paper** | `⋯` → Find in paper. Highlights every match, shows `3/17`, and steps with ‹ ›. Matches are wrapped in `<mark>` by walking text nodes, so stepping works forwards and backwards — which `window.find()` cannot do. Closing the bar un-highlights and normalises the DOM. |
| **Share** | `⋯` → Share. Sends the title and the arXiv abstract URL through the system share sheet. |
| **Save for offline** | `⋯` → Save for offline. Stores the article HTML on the device; reopening uses that copy instead of fetching. |
| **Theme** | Moved into the `⋯` menu as the header ran out of room. Still applied by injection, never by reload. |

### Settings & diagnostics

Reachable from the drawer. Contains the text size control, the daily reminder, the offline
count, and a **copyable diagnostics block**: app version and `versionCode`, device model,
screen size, counts of saved papers, history, positions and recent searches, text size,
whether a reminder is scheduled.

That block is the point. During a week of testing, "the paper broke" is not a report; a
paste with the version, the device and the counts is.

### Daily reminder

A local scheduled notification — no server, no push token. Tap the row to cycle through
off / 08:00 / 12:00 / 18:00 / 21:00. Android 13+ permission is requested when you turn it on,
and if it is refused the setting stays **off** rather than claiming a reminder that cannot be
delivered.

A seven-day test only produces seven days of data if something asks you to read on day three.

### Offline: what it does and does not store

**Text only.** The article HTML — prose, equations, structure — is saved; figures are not.
Figures are the overwhelming majority of a paper's bytes (measured earlier: 28 MB of figures
against 388 KB of text), so storing them turns one tap into a download manager with progress,
cancellation and eviction.

A `<base>` element pointing at arXiv is injected into the saved page, so figures still load
when there is a connection. Offline you get the text; online you get everything.

### Deliberately not built

Recommendations, text-to-speech, highlights and annotations. Each is a multi-day job with its
own failure modes, and none of them help you learn whether the reader is good.

### The dependency cost

`expo-notifications`, `expo-device` and `expo-file-system` are now declared dependencies, so
they are compiled into the APK. That is the price of the reminder, the device model in
diagnostics, and offline storage. If the week shows any of them unused, removing the feature
also removes the native module.

---

## 3. Building the APK

**This environment cannot build it.** There is no Android SDK, no Gradle, no `adb`, and no
`eas-cli`; the installed JDK is 26, which React Native and the Android Gradle Plugin do not
support (they want 17). Everything below runs on your machine.

### Option A — EAS Build (recommended; no Android SDK needed)

A cloud build. `eas.json` is already configured with a `preview` profile that emits an APK.

```bash
npm install -g eas-cli
eas login                       # free Expo account
cd mobile
eas build --platform android --profile preview
```

The build finishes with a URL and a QR code. Open it on the phone, allow install from
unknown sources, done. Roughly 10–20 minutes for a first build, less after.

To move to a store later, switch to the `production` profile, which emits an `.aab`.

### Option B — build it locally

Requires Android Studio, the SDK, and **JDK 17** specifically.

```bash
cd mobile
npx expo prebuild --platform android
cd android
./gradlew assembleRelease
```

Output: `android/app/build/outputs/apk/release/app-release.apk`. The native project is
gitignored — it is generated, and regenerating it is cheaper than merging it.

### Option C — install the SDK here

Possible in principle: `commandline-tools`, `platforms;android-35`, `build-tools`, JDK 17,
then a Gradle build. Several GB of download and a long first build under a sandbox. Worth
considering only if you want the APK produced without touching your machine.

### Installing on the Pixel 8

1. Settings → About phone → tap **Build number** seven times.
2. Settings → System → Developer options → **USB debugging**.
3. Either `adb install app.apk` over USB, or copy the APK across and tap it, allowing
   "install unknown apps" for the file manager.

### Two things to check on the first build

- **Permissions.** Prebuild adds `SYSTEM_ALERT_WINDOW`, `READ/WRITE_EXTERNAL_STORAGE` and
  `VIBRATE` from Expo's defaults. Harmless for a side-loaded test build; they will need
  trimming before a store submission, because `SYSTEM_ALERT_WINDOW` is a sensitive permission
  on Play.
- **`web` target.** `expo-system-ui` and the config changes affect native only; the web
  build is still what the verification harness drives.

---

## 4. Running the week

A test run is only worth seven days if you write something down.

**Daily, one line:** paper opened, did it restore, did anything render wrong, one thing that
annoyed you.

**Watch specifically for these**, because they are the parts that could only be verified in
a browser or not at all:

| Area | What to look for |
|---|---|
| **Old nav bar** | Any paper that still shows arXiv's dark header or icon toolbar above the app's. The before-load stylesheet injection has an after-load backstop; if something still slips through, that is the signal that the WebView is dropping both. |
| **Horizontal swipe** | Any page that pans sideways. `touch-action: pan-y` should make it impossible. |
| **Restore** | Open a paper, read past the first screen, go back, reopen. Should land where you left. The ⟲ is lit when a position is saved — if it is dimmed, saving is the broken half. |
| **Theme** | Toggle mid-paper. The article should recolour without reloading or moving. |
| **PDF path** | Only runs on a device; ~4% of papers. If one shows nothing, note the id. |
| **Saves** | Save a paper from a search result, then check it shows a title, not an arXiv id. |

**Send me the diagnostics screen contents with any report** — that is what it is for.
