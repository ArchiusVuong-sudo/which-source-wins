import { useEffect, useRef } from 'react';
import type { Summary } from '../shared/types';
import { useApi } from './api';
import { Badge, cx } from './components/ui';
import { QualityPage } from './pages/Quality';
import { RulesPage } from './pages/Rules';
import { SourcesPage } from './pages/Sources';
import { VehiclePage } from './pages/Vehicle';
import { VehiclesPage } from './pages/Vehicles';
import { href, useRoute, type Route } from './router';

const NAV: { page: Route['page']; label: string; to: Route }[] = [
  { page: 'sources', label: 'Sources', to: { page: 'sources' } },
  { page: 'vehicles', label: 'Vehicles', to: { page: 'vehicles', q: '', filter: 'all', field: '' } },
  { page: 'rules', label: 'Rules', to: { page: 'rules', field: 'trim' } },
  { page: 'quality', label: 'Quality', to: { page: 'quality' } },
];

export function App() {
  const route = useRoute();
  const summary = useApi<Summary>('/summary');
  const reloadSummary = summary.reload;
  // One key per page (and per vehicle), so typing in a search box does not refetch on every key.
  const routeKey = route.page === 'vehicle' ? `vehicle:${route.vin}` : route.page;

  // The header must never lag the page under it: refetch the summary on every page change (not
  // only after this tab's own approve, rebuild or decision) and when the window regains focus.
  const firstRoute = useRef(true);
  useEffect(() => {
    if (firstRoute.current) {
      firstRoute.current = false;
      return;
    }
    reloadSummary();
  }, [routeKey, reloadSummary]);
  useEffect(() => {
    window.addEventListener('focus', reloadSummary);
    return () => window.removeEventListener('focus', reloadSummary);
  }, [reloadSummary]);

  const active = route.page === 'vehicle' ? 'vehicles' : route.page;
  const s = summary.data;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1360px] items-center gap-8 px-6">
          <a href="#/sources" className="flex items-center gap-2.5">
            <img src="/favicon.svg" alt="" className="h-7 w-7" />
            <div className="leading-tight">
              <div className="text-sm font-semibold text-slate-900">which-source-wins</div>
              <div className="text-[11px] text-slate-500">Vehicle records from sources that disagree</div>
            </div>
          </a>
          <nav className="flex items-center gap-1">
            {NAV.map((n) => (
              <a
                key={n.page}
                href={href(n.to)}
                className={cx(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  active === n.page ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                )}
              >
                {n.label}
                {n.page === 'sources' && s && s.quarantined > 0 && (
                  <span className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold text-white">{s.quarantined}</span>
                )}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2 text-xs text-slate-500">
            {s && (
              <>
                <span className="tabular">
                  Build <b className="text-slate-800">#{s.buildId ?? '-'}</b>
                </span>
                <span className="text-slate-300">|</span>
                <span className="tabular">
                  Rules <b className="text-slate-800">v{s.ruleSetVersion}</b>
                </span>
                <span className="text-slate-300">|</span>
                <span className="tabular">
                  <b className="text-slate-800">{s.vehicles}</b> vehicles from <b className="text-slate-800">{s.records}</b> records
                </span>
              </>
            )}
            <Badge tone="amber" title="Every record, person and lot here is made up. Only the VIN pattern data is real reference data.">
              Synthetic data
            </Badge>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1360px] px-6 py-7">
        {route.page === 'sources' && <SourcesPage />}
        {route.page === 'vehicles' && <VehiclesPage route={route} />}
        {route.page === 'vehicle' && <VehiclePage vin={route.vin} />}
        {route.page === 'rules' && <RulesPage field={route.field} />}
        {route.page === 'quality' && <QualityPage />}
      </main>
      <footer className="mx-auto max-w-[1360px] px-6 pb-8 text-xs text-slate-400">
        Synthetic sources and truth labels. VIN patterns decoded offline from bundled NHTSA vPIC data. No network calls at runtime.
      </footer>
    </div>
  );
}
