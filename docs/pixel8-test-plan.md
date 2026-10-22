# Pixel 8 test run — features, cleanup, and the APK path

Prepared against `c854b3c` plus the changes in this commit.

---

## 1. What changed to get ready

### The codebase is now app-only

`mobile/` contains only what ships. The static-bundle loader and the on-device
recommendation pipeline moved to `lab/` at the repo root, with their tests and harness.
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

## 2. Features worth trying — and what to add first

The purpose of the week is learning, not breadth. **Every feature is another thing that can
break during the exact week you are trying to observe the app.** So the recommendation is a
small Tier 1, with everything else banked for week two.

### Tier 1 — add before the APK

| Feature | Why | Risk |
|---|---|---|
| **Text size control** | One `Aa` control in the reader header cycling three sizes, persisted. The CSS already has a `--font-size` variable; the spike had `A+/A−` buttons. Long reading sessions are the whole product, and 18px is a guess. | Low — one CSS variable, one persisted number |
| **In-app diagnostics** | A screen reachable from the drawer showing app version, device, counts (saved / history / positions), current reader mode, and the last reader error — with a **Copy** button. For a test run this is the highest-value item: it turns "the paper broke" into a reproducible report without a laptop. | Low — read-only, no new deps |
| **Share paper** | `Share.share()` with the arXiv abstract URL. Papers are read to be passed on. | Very low — ~15 lines, no deps |

### Tier 2 — week two, if the week goes well

| Feature | Why |
|---|---|
| **Daily reminder** | A local scheduled notification. Without one, a seven-day test quietly becomes a two-day test. Costs `expo-notifications` plus a permission prompt on Android 13+. |
| **Find in page** | Search the article and jump between matches. Reading a paper is often "where do they define X". |
| **Offline save** | Keep the article and its figures for a commute. The lazy-figure work is most of the plumbing already. |

### Tier 3 — deliberately not now

Recommendations, text-to-speech, highlights and annotations. Each is a multi-day job with
its own failure modes; none of them help you learn whether the reader is good.

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
