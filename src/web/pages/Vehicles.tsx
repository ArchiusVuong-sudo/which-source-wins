import { useMemo } from 'react';
import type { FieldName, SourceId, UnresolvedRecord, VehicleRow } from '../../shared/types';
import { useApi } from '../api';
import { Badge, Card, EmptyValue, ErrorBox, Loading, Mono, PageHeader, SourceChip, Td, Th, cx, fmtValue } from '../components/ui';
import { FIELD_LABEL } from '../labels';
import { href, navigate, type Route } from '../router';

type VehiclesRoute = Extract<Route, { page: 'vehicles' }>;

const FILTERS = [
  { id: 'all', label: 'All vehicles' },
  { id: 'conflict', label: 'Conflicts' },
  { id: 'empty', label: 'Empty fields' },
  { id: 'unresolved', label: 'Unresolved records' },
] as const;

const SOURCE_ORDER: SourceId[] = ['vin_pattern', 'registration', 'module_read', 'listing'];

export function VehiclesPage({ route }: { route: VehiclesRoute }) {
  const vehicles = useApi<VehicleRow[]>('/vehicles');
  const unresolved = useApi<UnresolvedRecord[]>('/unresolved');
  const set = (patch: Partial<VehiclesRoute>) => navigate({ ...route, ...patch }, true);
  const q = route.q.trim().toLowerCase();

  const emptyFields = useMemo(() => {
    const s = new Set<FieldName>();
    for (const v of vehicles.data ?? []) v.empty.forEach((f) => s.add(f));
    return [...s];
  }, [vehicles.data]);

  const rows = useMemo(() => {
    let list = vehicles.data ?? [];
    if (route.filter === 'conflict') list = list.filter((v) => v.conflicts.length > 0);
    if (route.filter === 'empty') list = list.filter((v) => (route.field ? v.empty.includes(route.field as FieldName) : v.empty.length > 0));
    if (q) list = list.filter((v) => v.vin.toLowerCase().includes(q) || v.title.toLowerCase().includes(q) || String(v.trim ?? '').toLowerCase().includes(q));
    return list;
  }, [vehicles.data, route.filter, route.field, q]);

  const counts = {
    all: vehicles.data?.length ?? 0,
    conflict: vehicles.data?.filter((v) => v.conflicts.length > 0).length ?? 0,
    empty: vehicles.data?.filter((v) => v.empty.length > 0).length ?? 0,
    unresolved: unresolved.data?.length ?? 0,
  };

  return (
    <div>
      <PageHeader
        title="Vehicles"
        description="One row per resolved vehicle in the latest build. Every value has a source and a rule; a field with no source stays empty and says why."
      />
      <div className="mb-4 flex items-center gap-3">
        <div className="relative w-80">
          <input
            value={route.q}
            onChange={(e) => set({ q: e.target.value })}
            placeholder="Search VIN, make, model or trim"
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm shadow-sm outline-none placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            aria-label="Search vehicles"
          />
        </div>
        <div className="flex rounded-lg bg-slate-100 p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => set({ filter: f.id, field: '' })}
              className={cx(
                'rounded-md px-3 py-1 text-sm font-medium transition-colors',
                route.filter === f.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900',
              )}
            >
              {f.label} <span className="tabular text-xs text-slate-400">{counts[f.id]}</span>
            </button>
          ))}
        </div>
        {route.filter === 'empty' && (
          <select
            value={route.field}
            onChange={(e) => set({ field: e.target.value })}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm shadow-sm"
            aria-label="Empty field"
          >
            <option value="">any field</option>
            {emptyFields.map((f) => (
              <option key={f} value={f}>
                {FIELD_LABEL[f]}
              </option>
            ))}
          </select>
        )}
      </div>

      {route.filter === 'unresolved' ? (
        <UnresolvedTable data={unresolved.data} loading={unresolved.loading} error={unresolved.error} q={q} />
      ) : (
        <Card padded={false}>
          {vehicles.loading && !vehicles.data && <Loading />}
          {vehicles.error && (
            <div className="p-4">
              <ErrorBox message={vehicles.error} onRetry={vehicles.reload} />
            </div>
          )}
          {vehicles.data && (
            <table className="w-full">
              <thead className="border-b border-slate-100 bg-slate-50/60">
                <tr>
                  <Th>VIN</Th>
                  <Th>Vehicle</Th>
                  <Th>Trim (decoded)</Th>
                  <Th>Observed trim</Th>
                  <Th className="text-right">Odometer</Th>
                  <Th>Records</Th>
                  <Th>Flags</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((v) => (
                  <tr key={v.vin} className="cursor-pointer hover:bg-indigo-50/40" onClick={() => (window.location.hash = href({ page: 'vehicle', vin: v.vin }))}>
                    <Td>
                      <a href={href({ page: 'vehicle', vin: v.vin })} className="font-mono text-[12.5px] font-medium text-indigo-700 hover:underline">
                        {v.vin}
                      </a>
                    </Td>
                    <Td className="whitespace-nowrap font-medium text-slate-900">{v.title}</Td>
                    <Td>{v.trim === null ? <EmptyValue compact /> : v.trim}</Td>
                    <Td className="text-slate-500">{v.observedTrim === null ? <span className="text-slate-300">-</span> : `"${v.observedTrim}"`}</Td>
                    <Td className="tabular whitespace-nowrap text-right">{v.odometerKm === null ? <EmptyValue compact /> : fmtValue(v.odometerKm, 'odometerKm')}</Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {SOURCE_ORDER.filter((s) => s !== 'vin_pattern' && v.sources[s]).map((s) => (
                          <SourceChip key={s} source={s} count={v.sources[s]} />
                        ))}
                      </div>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {v.flags.map((f) => (
                          <Badge key={f} tone="rose">
                            {f}
                          </Badge>
                        ))}
                        {v.conflicts
                          .filter((c) => c !== 'odometerKm')
                          .map((c) => (
                            <Badge key={c} tone="amber">
                              {FIELD_LABEL[c].toLowerCase()} conflict
                            </Badge>
                          ))}
                        {(route.filter === 'empty' ? v.empty : v.empty.filter((f) => f === 'registeredProvince')).map((f) => (
                          <Badge key={f} tone="slate">
                            no {FIELD_LABEL[f].toLowerCase()}
                          </Badge>
                        ))}
                      </div>
                    </Td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <Td colSpan={7} className="py-10 text-center text-slate-400">
                      No vehicles match.
                    </Td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </div>
  );
}

function UnresolvedTable({ data, loading, error, q }: { data: UnresolvedRecord[] | null; loading: boolean; error: string | null; q: string }) {
  const rows = (data ?? []).filter((r) => !q || r.recordId.toLowerCase().includes(q) || (r.vinRaw ?? '').toLowerCase().includes(q) || r.summary.toLowerCase().includes(q));
  return (
    <Card padded={false} title="Records the matcher did not link" subtitle="The matcher abstains rather than guess. Each record says why and names the vehicles it could have been.">
      {loading && !data && <Loading />}
      {error && (
        <div className="p-4">
          <ErrorBox message={error} />
        </div>
      )}
      {data && (
        <table className="w-full">
          <thead className="border-b border-slate-100 bg-slate-50/60">
            <tr>
              <Th>Record</Th>
              <Th>Source</Th>
              <Th>VIN as written</Th>
              <Th>What it says</Th>
              <Th>Why it is unmatched</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.recordId}>
                <Td>
                  <Mono>{r.recordId}</Mono>
                </Td>
                <Td>
                  <SourceChip source={r.source} />
                </Td>
                <Td>{r.vinRaw ? <Mono>{r.vinRaw}</Mono> : <EmptyValue compact />}</Td>
                <Td className="max-w-xs text-xs">{r.summary}</Td>
                <Td className="text-xs">
                  <div className="text-slate-700">{r.reason}</div>
                  {r.candidates.length > 0 && (
                    <ul className="mt-1 space-y-0.5">
                      {r.candidates.map((c) => {
                        const vin = c.slice(0, 17);
                        return (
                          <li key={c}>
                            <a className="font-mono text-indigo-700 hover:underline" href={href({ page: 'vehicle', vin })}>
                              {vin}
                            </a>
                            <span className="text-slate-500">{c.slice(17)}</span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </Td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <Td colSpan={5} className="py-10 text-center text-slate-400">
                  Every record is linked.
                </Td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </Card>
  );
}
