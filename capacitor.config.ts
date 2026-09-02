/* ⚠ THIS FILE IS NOT THE ONE THE APP IS BUILT FROM.
 *
 * The app's real config is mobile/capacitor.config.json, and every Capacitor
 * command runs from mobile/ (npm run add:android → `cd mobile && npx cap add
 * android`, which is why .gitignore lists mobile/android/).
 *
 * The two disagree about the most important setting there is:
 *
 *   mobile/capacitor.config.json  webDir: "www", no server.url
 *                                 → the app runs the bundled shell
 *   this file                     server.url: production
 *                                 → the app loads the live site remotely
 *
 * Those are different products. Running `npx cap` from the repo root picks
 * THIS file up, and the resulting build ignores mobile/www entirely — so a
 * change deployed to the web would appear in the app and a change bundled into
 * it would not, which is the opposite of how the rest of the repo is set up.
 *
 * It is left here rather than deleted because nobody currently alive knows
 * whether some other tooling reads it. If nothing does, delete it: two configs
 * that contradict each other are worse than either one.
 */

import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'co.za.svcapital.app',
  appName: 'SV Capital',
  // Points to the production Railway server — the app shell loads your live web app.
  // Change to 'http://10.0.2.2:3000' during local dev (Android emulator → localhost).
  server: {
    url: 'https://svcapital-production.up.railway.app',
    cleartext: false,
  },
  android: {
    buildOptions: {
      keystorePath: 'svcapital-release.keystore',
      keystoreAlias: 'svcapital',
    },
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 2000,
      backgroundColor: '#0d0f17',
      androidSplashResourceName: 'splash',
      showSpinner: false,
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
