# SV Capital — Mobile App

Capacitor-based native wrapper for the SV Capital Investor Portal.

**App ID:** `co.za.svcapital.app`  
**Platforms:** iOS (App Store) + Android (Google Play)

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 18+ | https://nodejs.org |
| npm | 9+ | bundled with Node |
| Android Studio | Latest | https://developer.android.com/studio |
| Xcode | 15+ (macOS only) | App Store |
| Java JDK | 17+ | `brew install openjdk@17` |

---

## Quick Start

```bash
cd mobile
npm install

# Build www/ from portal/ and sync to native projects
npm run sync

# Open in Android Studio
npm run open:android

# Open in Xcode (macOS only)
npm run open:ios
```

---

## First-time Setup

### 1. Install platforms (once)

```bash
cd mobile
npm install
npm run add:android
npm run add:ios      # macOS only
```

### 2. Copy native configs

After running `cap add android` / `cap add ios`, copy these files into the generated projects:

```bash
# Android
cp -r android-config/app/src/main/res/*               android/app/src/main/res/
cp    android-config/app/src/main/AndroidManifest.xml  android/app/src/main/
cp    android-config/variables.gradle                   android/variables.gradle

# iOS — copy Info.plist and Privacy Manifest into Xcode project
cp ios-config/App/App/Info.plist        ios/App/App/
cp ios-config/App/App/PrivacyInfo.xcprivacy  ios/App/App/
```

> **Note:** `PrivacyInfo.xcprivacy` (Apple Privacy Manifest) is **required** for App Store
> submissions since May 2024. After copying it, open Xcode → project navigator → right-click
> `App/App` group → **Add Files to "App"** → select `PrivacyInfo.xcprivacy`.

### 3. Generate icons & splash screens

```bash
npm install -D sharp
node scripts/gen-icons.js
```

### 4. Firebase setup (push notifications)

#### Android
1. Create a Firebase project at https://console.firebase.google.com
2. Add Android app with package `co.za.svcapital.app`
3. Download `google-services.json` → place at `android/app/google-services.json`

#### iOS
1. Add iOS app with bundle ID `co.za.svcapital.app`
2. Download `GoogleService-Info.plist` → place at `ios/App/App/GoogleService-Info.plist`
3. Enable Push Notifications capability in Xcode

### 5. Set production API URL

```bash
# Set in build env or edit scripts/build.js
export SVC_API_URL=https://your-railway-app.up.railway.app/api/
npm run build
```

---

## Build & Release

### Android (Google Play)

#### First-time signing setup (do once after `cap add android`)

The upload keystore is stored in `android-config/uploadkeystore.jks` (gitignored).

```bash
# 1. Copy the keystore into the app folder
cp android-config/uploadkeystore.jks android/app/uploadkeystore.jks

# 2. Create android/key.properties (gitignored) from the template
cp android-config/key.properties.template android/key.properties
# Then fill in the real storePassword, keyAlias, keyPassword values.

# 3. Apply signing config to android/app/build.gradle
# See android-config/signing-config.gradle.patch for exactly what to add/change.
```

After editing `android/app/build.gradle`, the `release` build type will automatically
use the upload key. **Never commit `key.properties` or `*.jks` to git.**

#### Build & upload

1. `npm run sync`
2. Open Android Studio: `npm run open:android`
3. **Build → Generate Signed Bundle/APK**
4. Choose **Android App Bundle (.aab)** → select **Release**
   *(signing is automatic if build.gradle is configured; or point to the keystore manually)*
5. Upload `.aab` to Google Play Console → Production

> **SHA1 fingerprint for the upload key:** `07:01:84:5B:FA:EF:8D:F6:46:CA:CB:5C:7B:14:EC:2D:1A:51:A5:F7`  
> **IMPORTANT:** The JKS has two aliases — always use alias **`upload`** (NOT `keystore`).  
> Verify with: `keytool -list -alias upload -keystore android/app/uploadkeystore.jks`

### iOS (App Store)

**Prerequisites:** Mac with Xcode 15+, Apple Developer account ($99/year at developer.apple.com)

#### One-time setup
1. Enrol in Apple Developer Programme and create an App ID `co.za.svcapital.app` in [App Store Connect](https://appstoreconnect.apple.com)
2. Create a new app listing: **Finance** category, **4+** age rating
3. Add Privacy Policy URL: `https://svcapital.co.za/popia.html`

#### Build & submit
1. `npm run add:ios` (first time only — generates `ios/` folder)
2. Copy native configs:
   ```bash
   cp ios-config/App/App/Info.plist             ios/App/App/
   cp ios-config/App/App/PrivacyInfo.xcprivacy  ios/App/App/
   ```
   Then in Xcode: right-click `App/App` group → **Add Files to "App"** → select `PrivacyInfo.xcprivacy`
3. Generate icons: `npm install -D sharp && node scripts/gen-icons.js`
4. `npm run sync`
5. Open Xcode: `npm run open:ios`
6. Select your **Team** in Signing & Capabilities tab
7. Confirm **Bundle Identifier** is `co.za.svcapital.app` — or just run `npm run check:ios`
8. Enable **Push Notifications** capability (+ toggle in Signing & Capabilities)
9. Enable **Associated Domains** capability → add `applinks:svcapital.co.za`
10. **Before archiving, run `npm run check:ios`** — see below
11. **Product → Archive** → Validate → **Distribute App → App Store Connect**
12. In App Store Connect: add screenshots (6.7" required), fill metadata, submit for review

#### Verify the Android project before building

```bash
npm run check:android
```

`android/` is gitignored and generated, so it drifts from `android-config/` the
same way `ios/` does. Checks the SDK levels against the template — **`targetSdk`
carries a Google Play deadline, after which Play stops accepting updates built
against an older target** — plus `applicationId` against `capacitor.config.json`
(it decides which Play listing a build belongs to), `strings.xml` `package_name`,
and whether `google-services.json` is present for push.

It reports `versionCode` but cannot judge it: Play requires it to strictly
increase and only Play knows what has already been uploaded.

`open:android` and `run:android` run it as a warning; run it directly for a hard
exit code.

#### Verify the project before archiving

```bash
npm run check:ios
```

`mobile/ios/` is gitignored and generated, so it drifts from `ios-config/` without
warning. Xcode only rejects a wrong bundle identifier or a reused build number at
**upload** — after you have waited through a full archive and sign. This runs the
same comparison in a second, beforehand, and checks:

- bundle identifier in `Info.plist` matches `ios-config` (resolving
  `$(PRODUCT_BUNDLE_IDENTIFIER)` through `project.pbxproj` when the plist holds a
  placeholder, and flagging a value that differs between build configurations)
- `PRODUCT_BUNDLE_IDENTIFIER` in `project.pbxproj`, checked separately — this is
  what Xcode uses to pick the signing profile, so it decides which App Store
  Connect record a build is delivered to. Both must be right: a correct plist with
  a stale build setting still signs against the wrong app.
- the identifier **per build configuration**, named. Debug and Release can hold
  different values, and **Archive uses Release** — so a project can build and run
  correctly all day and still upload to the wrong app. Fix these under
  **Build Settings → Product Bundle Identifier**, expanding the row and setting
  every configuration; the Signing & Capabilities field edits only the one
  currently selected.
- marketing version matches, and the build number is at least the template's
- `capacitor.config.json` `appId` agrees with the template
- `PrivacyInfo.xcprivacy` is present (required for App Store submission)

**What it cannot check:** anything that lives only on Apple's servers. It compares
your project against the repo template, so it cannot know which marketing versions
App Store Connect considers closed, or which build numbers already exist there.
Two rules are enforced only at upload:

- a marketing version whose build was **approved for sale** is a closed train and
  accepts no further uploads at any build number (error 90186) — bump
  `CFBundleShortVersionString`
- within a train, the build number must strictly increase (error 90062)

`open:ios` and `run:ios` run it as a warning — they never block, since you need
Xcode open to fix what it reports. Run `npm run check:ios` directly for a hard
exit code, e.g. in CI.

#### App Store review notes
- The app requires login — provide Apple a demo investor account in the review notes
- Mention FICA/KYC is for regulatory compliance (South African FSP obligation)
- The camera permission is used for document scanning during KYC verification

---

## Native Features

| Feature | Plugin | Status |
|---------|--------|--------|
| Push Notifications | `@capacitor/push-notifications` | ✅ Configured |
| Status Bar | `@capacitor/status-bar` | ✅ Dark + #0f1623 |
| Splash Screen | `@capacitor/splash-screen` | ✅ 2s fade |
| Network Detection | `@capacitor/network` | ✅ Offline banner |
| Haptic Feedback | `@capacitor/haptics` | ✅ On primary buttons |
| Back Button | `@capacitor/app` | ✅ Close modal / exit |
| Biometric Auth | `@capacitor/biometric-auth` | 🔧 Ready to wire |
| Deep Links | URL scheme `svcapital://` | ✅ Configured |
| App Links | `https://svcapital.co.za/investor/` | ✅ Configured |

---

## App Store Metadata

**Name:** SV Capital  
**Subtitle:** Alternative Investments  
**Category:** Finance  
**Age Rating:** 4+  
**Privacy:** Financial data, contact info  
**Keywords:** invest, cattle, solar, returns, south africa, alternative investments

**Short description (Play Store):**
> Manage your SV Capital investment portfolio — top up, invest in cattle & solar pools, track returns.

**Full description:**
> SV Capital gives South African investors access to high-yield alternative investment pools including cattle farming, solar energy, and short-term business lending.
> 
> Features:
> • Real-time portfolio overview with performance charts
> • Invest in Cattle, Solar, and Short-Term pools
> • Wallet top-up via Paystack card payment
> • Auto recurring top-up on your chosen date
> • FICA / KYC document upload and verification
> • Investment certificates and tax certificates (IT3b)
> • Referral programme with tracking dashboard
> • Maturity instructions and reinvestment options
> • Push notifications for deposits, returns, and maturity alerts

---

## Deep Links

| URL | Destination |
|-----|-------------|
| `svcapital://investor/view/wallet` | Wallet view |
| `svcapital://investor/view/marketplace` | Marketplace |
| `svcapital://investor/view/investments` | My Investments |
| `https://svcapital.co.za/investor/` | App home (Universal Link) |

---

## Project Structure

```
mobile/
├── package.json          — Capacitor dependencies
├── capacitor.config.json — App ID, plugins, server config
├── README.md             — This file
├── src/                  — Mobile-owned source. Mirrors the www/ layout and
│                           wins over portal/ + root js|css|assets/. EDIT HERE.
├── www/                  — Built web assets (generated — do NOT edit by hand)
├── android/              — Android native project (generated, gitignored)
├── ios/                  — iOS native project (generated, gitignored)
├── android-config/       — Config files to copy into android/
├── ios-config/           — Config files to copy into ios/
├── assets/
│   ├── icons/icon.svg    — Master app icon (1024×1024)
│   └── splash/splash.svg — Master splash (2732×2732)
└── scripts/
    ├── build.js          — Builds www/ from portal/ + mobile/src/
    └── gen-icons.js      — Generates all icon + splash PNG sizes
```

### Where to edit web code

`build.js` wipes and rebuilds `www/` on every run (and `npm run open:ios`,
`run:ios`, `open:android`, `run:android` all call it via `sync`). Layers, later
wins:

1. `portal/` — the web portal
2. root `js/`, `css/`, `assets/` — shared libraries
3. **`mobile/src/`** — mobile-owned files, mirroring the `www/` layout
4. Idempotent HTML patches (native config, loading cover)

**Edit `mobile/src/`, never `mobile/www/`.** A hand edit in `www/` is destroyed
by the next build. To make a file mobile-specific, copy it into `mobile/src/` at
the same relative path — it then shadows the shared copy, no allow-list needed.

Note that the files in `mobile/src/` are forks: `css/style.css`, `css/admin.css`,
`js/main.js`, `js/staff-auth.js` and others no longer track their `portal/`
counterparts, so web-side fixes to those do not reach the app. Delete a file from
`mobile/src/` to hand it back to the shared layer.
