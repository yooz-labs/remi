import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'live.yooz.remi',
  appName: 'Remi',
  webDir: 'dist',
  server: {
    // Allow loading external resources for development
    allowNavigation: ['*'],
  },
  ios: {
    contentInset: 'automatic',
    preferredContentMode: 'mobile',
    overrideUserAgent: 'Remi/1.0 iOS',
    backgroundColor: '#0e0e0c',
    scrollEnabled: false,
  },
  android: {
    // Use AndroidX WebView
    overrideUserAgent: 'Remi/1.0 Android',
    // Allow mixed content for development
    allowMixedContent: true,
  },
  plugins: {
    StatusBar: {
      style: 'dark',
      backgroundColor: '#0e0e0c',
    },
    Keyboard: {
      resize: 'none',
      scrollPadding: false,
    },
  },
};

export default config;
