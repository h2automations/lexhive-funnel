import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/funnel.css';
import './styles/ops.css';

/**
 * Google Tag Manager (GTM-P34XGVL3) is loaded here, in code, rather than in
 * index.html: /ops is an internal surface and must never fire marketing or
 * analytics tags (counting 2am debugging as campaign traffic distorts the
 * numbers spending decisions are made on). Every other route loads the
 * container normally. Container snippets in index.html cannot see the SPA
 * route, which is why the guard lives here.
 */
function loadGtm(id: string) {
  if (window.location.pathname.startsWith('/ops')) return;
  if (document.getElementById('gtm-script')) return;
  const script = document.createElement('script');
  script.id = 'gtm-script';
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtm.js?id=${id}`;
  document.head.appendChild(script);
}
loadGtm('GTM-P34XGVL3');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);