import { useEffect, useState } from 'react';

export type Route =
  | { page: 'sources' }
  | { page: 'vehicles'; q: string; filter: string; field: string }
  | { page: 'vehicle'; vin: string }
  | { page: 'rules'; field: string }
  | { page: 'quality' };

export function parseHash(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  const parts = path.split('/').filter(Boolean);
  switch (parts[0]) {
    case 'vehicles':
      if (parts[1]) return { page: 'vehicle', vin: decodeURIComponent(parts[1]) };
      return { page: 'vehicles', q: params.get('q') ?? '', filter: params.get('filter') ?? 'all', field: params.get('field') ?? '' };
    case 'rules':
      return { page: 'rules', field: params.get('field') ?? 'trim' };
    case 'quality':
      return { page: 'quality' };
    default:
      return { page: 'sources' };
  }
}

export function href(route: Route): string {
  switch (route.page) {
    case 'sources':
      return '#/sources';
    case 'vehicles': {
      const p = new URLSearchParams();
      if (route.q) p.set('q', route.q);
      if (route.filter && route.filter !== 'all') p.set('filter', route.filter);
      if (route.field) p.set('field', route.field);
      const s = p.toString();
      return `#/vehicles${s ? `?${s}` : ''}`;
    }
    case 'vehicle':
      return `#/vehicles/${encodeURIComponent(route.vin)}`;
    case 'rules':
      return `#/rules?field=${route.field}`;
    case 'quality':
      return '#/quality';
  }
}

export function navigate(route: Route, replace = false): void {
  const h = href(route);
  if (replace) history.replaceState(null, '', h);
  else window.location.hash = h;
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
