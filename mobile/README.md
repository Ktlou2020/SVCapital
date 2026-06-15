# SV Capital — Mobile App

Capacitor-based native wrapper for the SV Capital Investor Portal.

**App ID:** `co.za.svcapital.investor`  
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
2. Add Android app with package `co.za.svcapital.investor`
3. Download `google-services.json` → place at `android/app/google-services.json`

#### iOS
1. Add iOS app with bundle ID `co.za.svcapital.investor`
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

1. `npm run sync`
2. Open Android Studio: `npm run open:android`
3. **Build → Generate Signed Bundle/APK**
4. Choose **Android App Bundle (.aab)**
5. Create or use existing keystore
6. Upload `.aab` to Google Play Console → Production

### iOS (App Store)

**Prerequisites:** Mac with Xcode 15+, Apple Developer account ($99/year at developer.apple.com)

#### One-time setup
1. Enrol in Apple Developer Programme and create an App ID `co.za.svcapital.investor` in [App Store Connect](https://appstoreconnect.apple.com)
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
7. Confirm **Bundle Identifier** is `co.za.svcapital.investor`
8. Enable **Push Notifications** capability (+ toggle in Signing & Capabilities)
9. Enable **Associated Domains** capability → add `applinks:svcapital.co.za`
10. **Product → Archive** → Validate → **Distribute App → App Store Connect**
11. In App Store Connect: add screenshots (6.7" required), fill metadata, submit for review

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
├── www/                  — Built web assets (generated, gitignored)
├── android/              — Android native project (generated, gitignored)
├── ios/                  — iOS native project (generated, gitignored)
├── android-config/       — Config files to copy into android/
├── ios-config/           — Config files to copy into ios/
├── assets/
│   ├── icons/icon.svg    — Master app icon (1024×1024)
│   └── splash/splash.svg — Master splash (2732×2732)
└── scripts/
    ├── build.js          — Copies portal/ → www/ + injects native config
    └── gen-icons.js      — Generates all icon + splash PNG sizes
```
