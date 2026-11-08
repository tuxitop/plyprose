import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

if ('serviceWorker' in navigator && window.location.protocol === 'https:') {
  window.addEventListener('load', () => {
    const base = (import.meta.env.BASE_URL || './').replace(/\/+$/, '');
    const swUrl = base ? `${base}/sw.js` : './sw.js';
    navigator.serviceWorker.register(swUrl).catch(() => {});
  });
}
