import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/oxanium';
import '@fontsource-variable/jetbrains-mono';
import './styles/app.css';
import { App } from './App';
import { installMotion } from './lib/motion';

installMotion();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* PWA offline shell unavailable; the app still works online */
    });
  });
}
