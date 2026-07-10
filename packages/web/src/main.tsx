import { App as CapApp } from '@capacitor/app';
import { Network } from '@capacitor/network';
import { StatusBar } from '@capacitor/status-bar';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Bundled variable fonts (offline-first; no CDN). Inter Tight for UI/display,
// JetBrains Mono for code, hosts, and technical labels.
import '@fontsource-variable/inter-tight';
import '@fontsource-variable/jetbrains-mono';
import './index.css';
import App from './App.tsx';
import { syncNativeStatusBarTheme } from './lib/native-theme';
import { initNotifications } from './lib/notifications';
import { isNative } from './lib/platform';

/** Initialize native platform features after React mount */
async function initNative(): Promise<void> {
  if (!isNative()) return;

  try {
    // #778: shared with the theme-change listener in App.tsx so the status
    // bar stays in sync after startup too, not just at this one-shot sample.
    // App.tsx's settings effect calls this again on mount, ahead of or behind
    // this one depending on effect-flush timing -- harmless (idempotent,
    // no-op on web), not worth ordering around.
    await syncNativeStatusBarTheme();
    await StatusBar.setOverlaysWebView({ overlay: true });
  } catch (err) {
    console.warn('[initNative] StatusBar setup failed:', err);
  }

  try {
    // Handle hardware back button (Android) and app state changes
    await CapApp.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack) {
        window.history.back();
      }
    });
    await CapApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) {
        document.dispatchEvent(new CustomEvent('app-resume'));
        // Force reconnect stale WebSockets after returning from background
        document.dispatchEvent(new CustomEvent('app-force-reconnect'));
      }
    });
  } catch (err) {
    console.warn('[initNative] App lifecycle listeners failed:', err);
  }

  try {
    // Monitor network changes (WiFi <-> cellular transitions)
    await Network.addListener('networkStatusChange', (status) => {
      if (status.connected) {
        // Network interface changed; force reconnect on new route
        document.dispatchEvent(new CustomEvent('app-force-reconnect'));
      }
    });
  } catch (err) {
    console.warn('[initNative] Network monitoring failed:', err);
  }

  try {
    // Initialize notifications (local + APNS push token registration)
    await initNotifications((token) => {
      // Device token received; dispatch event so App.tsx can send it to daemon
      document.dispatchEvent(new CustomEvent('device-token', { detail: token }));
    });
  } catch (err) {
    console.warn('[initNative] Notification setup failed:', err);
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

initNative().catch((err) => {
  console.warn('[initNative] Failed to initialize native features:', err);
});
