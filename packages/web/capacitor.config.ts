import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.yooz.remi',
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
    // Splash screen configuration (when @capacitor/splash-screen is added)
    SplashScreen: {
      launchShowDuration: 2000,
      backgroundColor: '#1a1a2e',
      showSpinner: false,
    },
    // Status bar configuration (when @capacitor/status-bar is added)
    StatusBar: {
      style: 'dark',
      backgroundColor: '#1a1a2e',
    },
  },
};

export default config;
