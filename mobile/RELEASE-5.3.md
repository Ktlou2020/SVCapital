# Android release 5.3 (build 95)

Everything in this release is already live on the server; none of it reaches
phones until a build is uploaded. Seven batches of portal work have accumulated
since 5.2, and two of them are things that have **never worked on a phone at
all**: the factsheet viewer, and saving any document. Both are fixed here, so
this build is what makes two features clients could not use reachable.

`mobile/version.json` is set to `5.3` / `androidVersionCode 95`, and
`ios-config/Info.plist` has been propagated to match. `www/` is rebuilt and
points at `https://svcapital-production.up.railway.app/api/`.

---

## What is in it

| | |
|---|---|
| **Factsheets open at last** | Android's WebView has no PDF renderer, so an `<iframe>` on a PDF painted nothing — every factsheet under every product opened to a blank screen. They are now rendered page by page with a vendored pdf.js. |
| **The sign-in fix** | An invitation link could sign the reader in as whoever last used that phone. A session is now only ever renewed, never created. |
| **Invitations push the app** | A new member is sent to the store rather than a browser form — so this build is what they will download. |
| **Documents actually save** | A WebView has no download manager, so every certificate, receipt, IT3b, sub-account statement, analytics CSV and data export said "downloaded" and wrote nothing. All eleven now go through the share sheet, and a device that cannot is told so instead. |
| **The calculator** | It had its own rate box and a term select of 6/12/18/24/36, and it snapped each pool's REAL term to the nearest of those — five months calculated over six, seven years over three. Both figures now come from the chosen pool and are shown rather than entered. |
| **Saving the statement on Android** | The button tested one name for "am I in the app" while the app sets another, so it fell through to the browser's print and did nothing. |
| **Button labels fit** | Long labels were clipped mid-word on a phone — "Confirm that I will be a signato". They wrap now. |
| **Refer & Earn above Policies** | It sat outside the collapsible menu group, so it rendered below everything in it. |
| **"Avg return p.a." is per annum** | The product grid showed each pool's return over its *own* period under a p.a. label — seven years' return as one year's on solar. |
| **One Print / Save PDF button** | The statement had two; the one that remains goes through the share sheet, because the other calls the browser's print, which does nothing on a phone. |
| **Quest cards** | "Refer Your First Friend" showed a padlock beside the word "Available" and offered no way to act on it. |
| **Murabaha minimum** | R1 000 000 on the product card and throughout the EIF training. |
| **Group workspace** | The stokvel work, the group setup redesign and the group documents flow. |

### Play Console "What's new" (copy this)

```
• Factsheets now open properly — PDFs no longer show a blank screen
• Certificates, receipts and statements now save properly — you can share them
  or keep them in Files
• Fixed a sign-in issue that could show the wrong account on a shared phone
• Investment calculator now uses each pool's real rate and real term
• Average returns are now shown per year across all products
• Clearer rewards cards, with a button that takes you where you need to go
• Refer & Earn is easier to find in the menu
• Murabaha minimum updated to R1 000 000
```

---

## Releasing it

The signing key is gitignored and must stay out of any chat or log, so steps
2–3 can only be done on a machine that already has it.

```bash
cd mobile
npm install
npm run add:android          # first time on this machine only

# the keystore and its passwords — never committed, never pasted anywhere
cp android-config/uploadkeystore.jks android/app/uploadkeystore.jks
cp android-config/key.properties.template android/key.properties
#   then fill in storePassword / keyAlias / keyPassword by hand

npm run apply:android        # writes signing config + version 5.3 / 95
npm run check:android        # hard exit code — run it before building
npm run sync                 # rebuilds www/ and copies it into android/
npm run open:android
```

Then in Android Studio: **Build → Generate Signed Bundle/APK → Android App
Bundle (.aab) → Release**, and upload to Play Console → Production.

Or skip Android Studio entirely — `npm run release:android` does the sync, the
apply, the check and `./gradlew bundleRelease` in one, and leaves the bundle at
`android/app/build/outputs/bundle/release/app-release.aab`. It reads
`key.properties`, so it signs only once that file is filled in; without it the
bundle comes out UNSIGNED and Play will reject it.

### What has already been verified, and what has not

Generating the project and applying the config need no Android SDK and no key,
so they were done and checked:

- `npx cap add android` generates cleanly against Capacitor 6.
- `npm run apply:android` writes the signing config, the manifest, the network
  security config and the version — `versionCode 1 → 95`, `versionName
  "1.0" → "5.3"`.
- `npm run check:android` passes: minSdk 22, compileSdk 36, targetSdk 36,
  applicationId `co.za.svcapital.app`, versionCode 95, versionName 5.3.
- `check:version`, `check:apply` and `check:api` all pass.

What cannot be done anywhere but a machine holding the key:

- **Compiling.** The Android SDK comes from `dl.google.com`, which a cloud
  session cannot reach. Gradle, Maven Central and `maven.google.com` are all
  reachable — only the SDK itself is not.
- **Signing.** The keystore is gitignored and belongs on your machine. An
  unsigned bundle cannot be uploaded, so there is no useful half-build.

- Use alias **`upload`**, not `keystore` — the JKS holds both.
  `keytool -list -alias upload -keystore android/app/uploadkeystore.jks`
- Upload key SHA1: `07:01:84:5B:FA:EF:8D:F6:46:CA:CB:5C:7B:14:EC:2D:1A:51:A5:F7`
- `google-services.json` must be at `android/app/` or push notifications are
  silently dead in the build.

### If build 95 is rejected as already used

Only Play knows which codes have been uploaded; no local check can. Raise
`androidVersionCode` in `mobile/version.json`, re-run `npm run apply:android`,
and rebuild. Leave `versionName` alone — it is the marketing version and 5.3
is already correct.

### iOS

`version.json` drives both stores, so this has opened the **5.3 iOS train** and
abandoned 5.2: anything already uploaded under 5.2 stays there and cannot be
promoted. iOS needs a Mac with Xcode; see README.md.
