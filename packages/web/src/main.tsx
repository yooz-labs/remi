import { StatusBar, Style } from '@capacitor/status-bar';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { isNative } from './lib/platform';

/** Initialize native platform features after React mount */
async function initNative(): Promise<void> {
  if (!isNative()) return;

  const prefersDark =
    document.documentElement.getAttribute('data-theme') === 'dark' ||
    window.matchMedia('(prefers-color-scheme: dark)').matches;

  await StatusBar.setStyle({ style: prefersDark ? Style.Dark : Style.Light });
  await StatusBar.setOverlaysWebView({ overlay: true });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

initNative().catch((err) => {
  console.warn('[initNative] Failed to initialize native features:', err);
});
