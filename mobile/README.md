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

## On-demand iPhone builds

[Build Jellyree for iPhone](https://github.com/RusAbk/jellyree/actions/workflows/ios-device.yml) exports an Ad Hoc IPA for registered iPhones and iPads from `main`. Set up signing once, then use **Actions → Build Jellyree for iPhone → Run workflow** for each build.

1. Register your device UDIDs in the Apple Developer Program. Create an Ad Hoc provisioning profile for `app.jellyree.mobile` that includes those devices and your Apple Distribution certificate. Export the certificate and its private key from Keychain Access as a password-protected `.p12` file. [Apple provisioning guide](https://developer.apple.com/help/account/provisioning-profiles/create-an-ad-hoc-provisioning-profile)
2. Create the GitHub Actions environment `ios-device` and restrict deployments to `main`. Add the following environment secrets. [GitHub signing guide](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications)

   | Secret | Value |
   | --- | --- |
   | `IOS_BUILD_CERTIFICATE_BASE64` | Base64 of the complete `.p12` file |
   | `IOS_BUILD_CERTIFICATE_PASSWORD` | The password set when exporting the `.p12` file |
   | `IOS_PROVISIONING_PROFILE_BASE64` | Base64 of the complete Ad Hoc `.mobileprovision` file |

   On macOS, `base64 -i filename | pbcopy` copies the value to paste into GitHub.

3. Run `brew install age` and `age-keygen -o jellyree-ipa.agekey` on your Mac. Set the `IOS_IPA_RECIPIENT` environment **variable** to the public `age1…` key printed by `age-keygen`. Keep `jellyree-ipa.agekey` on your Mac. The workflow encrypts the IPA because a signed app embeds the provisioning profile with device UDIDs, and artifacts in this repository can be downloaded by users with read access. [GitHub artifact access](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)
4. Download the `jellyree-iphone-encrypted` artifact and extract `Jellyree.ipa.age`. Decrypt it and install `Jellyree.ipa` on a registered device from your Mac using Apple Configurator or Xcode. [Apple device installation guide](https://developer.apple.com/documentation/xcode/distributing-your-app-to-registered-devices)

   ```sh
   age -d -i jellyree-ipa.agekey -o Jellyree.ipa Jellyree.ipa.age
   ```

## Browser smoke test

The browser smoke test runs the actual mobile UI with a fixture bridge:

```sh
node mobile/test/ui-smoke.mjs
```

It uses `/usr/bin/google-chrome` by default. Set `CHROME_PATH` to another Chromium executable. Device testing should additionally check the system pickers, Keychain, inline media playback, and share sheets.

Uploads continue while browsing within the app. iOS or Android can suspend the Flutter process when it leaves the foreground.
