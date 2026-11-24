# Jellyree Mobile

The iOS and Android application uses Flutter for the native shell, credential storage, file and photo pickers, and sharing. The Flutter bundle includes the Jellyree catalog, viewers, and editors. It loads those assets through an app-private loopback connection and uses HTTPS to connect directly to Cloudflare R2 and D1.

The mobile connection accepts the same account ID, D1 database ID and token, R2 bucket and keys, and object prefix as the desktop app. It reuses the existing catalog. Each device stores its own credentials in Keychain or Android encrypted storage.

## Run locally

Use Node 24 and Flutter 3.50 or newer. The minimum deployment targets are iOS 17 and Android 7.0 (API 24).

From the repository root:

```sh
npm ci --prefix desktop
node mobile/tool/build-ui.mjs
cd mobile
flutter pub get
flutter run
```

Rebuild the bundled UI after changes to the shared renderer. The generated assets are excluded from Git.

## Verify and build

```sh
flutter analyze
flutter test
flutter build ios --simulator --debug --no-codesign
flutter build apk --debug
```

Build iOS on macOS with Xcode. To install on a physical iPhone, select a signing team for the Runner target in Xcode. The Android APK is written to `build/app/outputs/flutter-apk/`.

The browser smoke test runs the actual mobile UI with a fixture bridge:

```sh
node mobile/test/ui-smoke.mjs
```

It uses `/usr/bin/google-chrome` by default. Set `CHROME_PATH` to another Chromium executable. Device testing should additionally check the system pickers, Keychain, inline media playback, and share sheets.

Uploads continue while browsing within the app. iOS or Android can suspend the Flutter process when it leaves the foreground.
