/**
 * Мини-роутер на hash — работает и в Electron (file://), и в браузере.
 * Пример: #/home, #/clipboard?tab=image, #/settings?section=features
 */

import { useEffect, useState } from 'react';

export const PAGES = ['home', 'dictionary', 'hotkeys', 'clipboard'];

export function parseHash(hash = typeof location !== 'undefined' ? location.hash : '') {
  const raw = String(hash || '').replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const params = Object.fromEntries(new URLSearchParams(query).entries());
  const page = PAGES.includes(path) ? path : path === 'settings' ? 'settings' : 'home';
  return { page, params, raw };
}

export function toHash(page, params = {}) {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  });
  const query = q.toString();
  return `#/${page}${query ? `?${query}` : ''}`;
}

export function navigate(page, params = {}) {
  if (typeof location === 'undefined') return;
  const next = toHash(page, params);
  if (location.hash === next) return;
  location.hash = next;
}

export function replace(page, params = {}) {
  if (typeof history === 'undefined') return;
  history.replaceState(null, '', toHash(page, params));
}

export function useRoute() {
  const [route, setRoute] = useState(() => parseHash());
  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export default { parseHash, toHash, navigate, replace, useRoute };
