import { useEffect, useState } from 'react';

export interface Route {
  readonly page: string;
  readonly params: URLSearchParams;
}

export function parseHash(hash: string = window.location.hash): Route {
  const h = hash.replace(/^#\/?/, '');
  const q = h.indexOf('?');
  const page = (q < 0 ? h : h.slice(0, q)) || 'explore';
  return { page, params: new URLSearchParams(q < 0 ? '' : h.slice(q + 1)) };
}

export function hashFor(page: string, params: Record<string, string | number | undefined> = {}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v));
  const qs = p.toString();
  return `#/${page}${qs ? `?${qs}` : ''}`;
}

/** Replace the hash without adding a history entry or re-triggering routing. */
export function replaceHash(hash: string): void {
  if (window.location.hash !== hash) history.replaceState(null, '', hash);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash());
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
