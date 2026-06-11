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
