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
    // Use WKWebView configuration for better performance
    contentInset: 'automatic',
    preferredContentMode: 'mobile',
    // Support dark mode
    overrideUserAgent: 'Remi/1.0 iOS',
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
      backgroundColor: '#1a1d21',
    },
    Keyboard: {
      resize: 'body',
      scrollPadding: false,
    },
  },
};

export default config;
