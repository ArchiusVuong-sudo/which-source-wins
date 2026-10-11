import { useState } from 'react';
import type { FieldName, GoldenField, MatchedRecord, VehicleDetail } from '../../shared/types';
import { useApi } from '../api';
import { Badge, Card, EmptyValue, ErrorBox, Loading, Mono, SourceChip, Th, cx, fmtValue } from '../components/ui';
import { DECODED_FIELDS, FIELD_LABEL, OBSERVED_FIELDS } from '../labels';
import { href } from '../router';

const SECTIONS: { from: number; to: number; label: string }[] = [
  { from: 1, to: 3, label: 'Manufacturer' },
  { from: 4, to: 8, label: 'Descriptor' },
  { from: 9, to: 9, label: 'Check' },
  { from: 10, to: 10, label: 'Year' },
  { from: 11, to: 11, label: 'Plant' },
  { from: 12, to: 17, label: 'Serial' },
];

export function VehiclePage({ vin }: { vin: string }) {
  const d = useApi<VehicleDetail>(`/vehicles/${encodeURIComponent(vin)}`);
  const [hover, setHover] = useState<FieldName | null>(null);

  if (d.loading && !d.data) return <Loading label="Loading vehicle" />;
  if (d.error) return <ErrorBox message={d.error} onRetry={d.reload} />;
  if (!d.data) return null;
  const { golden, records, buildId } = d.data;
  const f = golden.fields;
  const lit = hover ? (f[hover].pattern?.positions ?? []) : [];
  const title = [f.modelYear.value, f.make.value, f.model.value].filter((x) => x !== null).join(' ');

  return (
    <div>
      <a href={href({ page: 'vehicles', q: '', filter: 'all', field: '' })} className="text-sm text-slate-500 hover:text-slate-800">
        ← Vehicles
      </a>
      <div className="mt-2 mb-5 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">
            {title} {f.trim.value !== null && <span className="text-slate-500">{f.trim.value}</span>}
          </h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-slate-500">
            <Mono className="text-slate-700">{golden.vin}</Mono>
            <span className="text-slate-300">|</span>
            <span>{records.length} matched records</span>
            <span className="text-slate-300">|</span>
            <span>build #{buildId}</span>
            <Badge tone="amber">Synthetic record</Badge>
          </div>
        </div>
      </div>

      {/* The VIN strip sticks while the golden table scrolls, and stops at the end of it. */}
      <div className="mb-5">
        <Card className="sticky top-14 z-10 mb-5" title="VIN" subtitle={hover ? `${FIELD_LABEL[hover]}: ${describePattern(f[hover])}` : 'Hover a decoded field to light the VIN characters its manufacturer pattern reads.'}>
          <VinStrip vin={golden.vin} lit={lit} />
        </Card>

        <Card padded={false} title="Golden record" subtitle="Each field: the winning value, its source and tier, the rule that picked it, and every other value a source reported.">
          <table className="w-full table-fixed">
            <colgroup>
              <col className="w-[170px]" />
              <col className="w-[200px]" />
              <col className="w-[140px]" />
              <col className="w-[300px]" />
              <col />
            </colgroup>
            <thead className="border-b border-slate-100 bg-slate-50/60">
              <tr>
                <Th>Field</Th>
                <Th>Value</Th>
                <Th>Source</Th>
                <Th>Rule</Th>
                <Th>Also reported and why</Th>
              </tr>
            </thead>
            <Group label="Decoded from the VIN pattern" fields={DECODED_FIELDS} golden={f} hover={hover} setHover={setHover} />
            <Group label="Observed by sources" fields={OBSERVED_FIELDS} golden={f} hover={hover} setHover={setHover} />
            <Group label="Seller text, kept apart from decoded fields" fields={['observedTrim']} golden={f} hover={hover} setHover={setHover} />
          </table>
        </Card>
      </div>

      <Card className="mb-5" title="Matched records" subtitle="Every link between records says why it was made." padded={false}>
        <div className="divide-y divide-slate-100">
          {records.map((r) => (
            <RecordRow key={r.recordId} r={r} vin={golden.vin} />
          ))}
        </div>
      </Card>

      <details className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <summary className="cursor-pointer px-5 py-3.5 text-sm font-semibold text-slate-900">Raw JSON (GET /api/vehicles/{golden.vin})</summary>
        <pre className="max-h-[480px] overflow-auto border-t border-slate-100 bg-slate-950 p-4 text-[12px] leading-relaxed text-slate-200">{JSON.stringify(golden, null, 2)}</pre>
      </details>
    </div>
  );
}

function describePattern(g: GoldenField): string {
  if (!g.pattern) return 'not read from the VIN pattern';
  const pos = g.pattern.positions;
  const where = pos.length ? `reads position${pos.length > 1 ? 's' : ''} ${ranges(pos)}` : 'reads no fixed position';
  return `${g.pattern.element} ${where}${g.pattern.rawPattern ? `, pattern ${g.pattern.rawPattern}` : ''}`;
}

function ranges(pos: number[]): string {
  const out: string[] = [];
  let start = pos[0]!;
  let prev = start;
  for (const p of [...pos.slice(1), Infinity]) {
    if (p !== prev + 1) {
      out.push(start === prev ? String(start) : `${start}-${prev}`);
      start = p;
    }
    prev = p;
  }
  return out.join(', ');
}

function VinStrip({ vin, lit, marks, small }: { vin: string; lit: number[]; marks?: number[]; small?: boolean }) {
  const chars = vin.padEnd(17, ' ').slice(0, 17).split('');
  return (
    <div>
      <div className="flex gap-1.5">
        {SECTIONS.map((s) => (
          <div key={s.label} className="flex flex-col">
            <div className="flex gap-1">
              {chars.slice(s.from - 1, s.to).map((c, i) => {
                const pos = s.from + i;
                const on = lit.includes(pos);
                const mark = marks?.includes(pos);
                return (
                  <div key={pos} className="flex flex-col items-center">
                    <div
                      className={cx(
                        'flex items-center justify-center rounded-md border font-mono font-semibold transition-all duration-150',
                        small ? 'h-7 w-6 text-sm' : 'h-11 w-9 text-lg',
                        on ? 'border-violet-500 bg-violet-600 text-white shadow-md shadow-violet-200' : mark ? 'border-rose-400 bg-rose-50 text-rose-700' : 'border-slate-200 bg-slate-50 text-slate-800',
                      )}
                    >
                      {c}
                    </div>
                    {!small && <div className={cx('mt-1 text-[10px] tabular', on ? 'font-semibold text-violet-700' : 'text-slate-400')}>{pos}</div>}
                  </div>
                );
              })}
            </div>
            {!small && <div className="mt-1 border-t border-slate-200 pt-1 text-center text-[10px] uppercase tracking-wide text-slate-400">{s.label}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function Group({ label, fields, golden, hover, setHover }: { label: string; fields: FieldName[]; golden: Record<FieldName, GoldenField>; hover: FieldName | null; setHover: (f: FieldName | null) => void }) {
  return (
    <tbody className="divide-y divide-slate-100 border-b border-slate-100">
      <tr>
        <td colSpan={5} className="bg-slate-50/40 px-3 pt-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {label}
        </td>
      </tr>
      {fields.map((name) => (
        <FieldRow key={name} name={name} g={golden[name]} seller={name === 'trim' ? golden.observedTrim : null} active={hover === name} onEnter={() => setHover(golden[name].pattern ? name : null)} onLeave={() => setHover(null)} />
      ))}
    </tbody>
  );
}

function FieldRow({ name, g, seller, active, onEnter, onLeave }: { name: FieldName; g: GoldenField; seller: GoldenField | null; active: boolean; onEnter: () => void; onLeave: () => void }) {
  const flagged = g.flags.some((x) => x.includes('below an earlier'));
  return (
    <tr
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      data-field={name}
      className={cx('transition-colors', active && 'bg-violet-50/70', g.conflict && 'shadow-[inset_3px_0_0_0] shadow-amber-400', flagged && 'shadow-rose-400')}
    >
      <td className="px-3 py-2.5 align-top text-sm font-medium text-slate-700">{FIELD_LABEL[name]}</td>
      <td className="px-3 py-2.5 align-top text-sm">
        {g.value === null ? (
          <EmptyValue reason={g.reason} />
        ) : (
          <span className={cx('font-semibold text-slate-900', name === 'observedTrim' && 'font-normal italic text-slate-600')}>
            {name === 'observedTrim' ? `"${g.value}"` : fmtValue(g.value, name)}
          </span>
        )}
        {g.asOf && <div className="mt-0.5 text-[11px] text-slate-400">as of {g.asOf}</div>}
      </td>
      <td className="px-3 py-2.5 align-top">{g.source ? <SourceChip source={g.source} tier={g.tier} /> : <span className="text-xs text-slate-300">none</span>}</td>
      <td className="px-3 py-2.5 align-top">
        <Mono className="whitespace-nowrap text-[11.5px] text-slate-600">
          {g.ruleId} <span className="text-slate-400">v{g.ruleVersion}</span>
        </Mono>
        {g.pattern && g.pattern.positions.length > 0 && <div className="mt-0.5 text-[11px] text-violet-600">reads VIN {ranges(g.pattern.positions)}</div>}
      </td>
      <td className="px-3 py-2.5 align-top text-xs">
        {g.alsoReported.length > 0 && (
          <div className="mb-1 flex flex-wrap gap-x-3 gap-y-1">
            {g.alsoReported.map((a, i) => (
              <span key={i} className={cx('inline-flex items-center gap-1', a.flag ? 'text-rose-700' : a.agrees ? 'text-slate-600' : 'text-amber-800')} title={a.recordId ?? ''}>
                <span className={cx('font-medium', a.flag && 'line-through decoration-rose-400')}>{fmtValue(a.value, name)}</span>
                <SourceChip source={a.source} />
                {a.asOf && <span className="text-slate-400">{a.asOf}</span>}
              </span>
            ))}
          </div>
        )}
        {g.flags.map((x) => (
          <div key={x} className={cx('font-medium', x.includes('below an earlier') ? 'text-rose-700' : 'text-amber-800')}>
            {x}
          </div>
        ))}
        <div className="text-slate-500">{g.reason}</div>
        {seller && seller.value !== null && g.source !== 'listing' && (
          <div className="mt-0.5 text-slate-500">
            Seller wrote <span className="font-medium italic text-slate-700">"{seller.value}"</span>: kept as observed trim, never used here.
          </div>
        )}
      </td>
    </tr>
  );
}

const METHOD_LABEL = { exact: 'Exact VIN', repair: 'VIN repaired', attribute: 'Attribute match' } as const;

function RecordRow({ r, vin }: { r: MatchedRecord; vin: string }) {
  const [open, setOpen] = useState(r.link.method !== 'exact');
  return (
    <div className="px-5 py-3.5">
      <div className="flex items-center gap-3">
        <SourceChip source={r.source} tier={r.tier} long />
        <Mono className="text-slate-500">{r.recordId}</Mono>
        {r.observedAt && <span className="text-xs text-slate-400">{r.observedAt}</span>}
        <Badge tone={r.link.method === 'exact' ? 'green' : r.link.method === 'repair' ? 'amber' : 'indigo'}>{METHOD_LABEL[r.link.method]}</Badge>
        <span className="text-sm text-slate-700">{r.link.detail}</span>
        <button onClick={() => setOpen((o) => !o)} className="ml-auto text-xs font-medium text-indigo-600 hover:underline">
          {open ? 'Hide evidence' : 'Show evidence'}
        </button>
      </div>
      {open && (
        <div className="mt-3 grid grid-cols-[1fr_1fr] gap-5">
          <div className="space-y-3 text-xs">
            <div>
              <div className="mb-1 font-semibold uppercase tracking-wide text-slate-400">VIN as written</div>
              {r.vinRaw ? (
                <div className="flex items-center gap-3">
                  <VinStrip vin={r.vinRaw} lit={[]} marks={r.link.repair?.positions ?? (r.vinCheck === 'pass' ? [] : [9])} small />
                  <VinCheck r={r} />
                </div>
              ) : (
                <span className="text-slate-500">No VIN in this record.</span>
              )}
            </div>
            {r.link.repair && (
              <div>
                <div className="mb-1 font-semibold uppercase tracking-wide text-slate-400">Repaired to the only known VIN in reach</div>
                <VinStrip vin={r.link.repair.to} lit={r.link.repair.positions} small />
              </div>
            )}
            {r.link.blocking && (
              <div className="rounded-lg bg-slate-50 p-3 text-slate-600">
                Blocked on make <b>{r.link.blocking.make}</b>, model <b>{r.link.blocking.model}</b>, year <b>{r.link.blocking.modelYear}</b>, seller <b>{r.link.blocking.seller}</b> and a{' '}
                {r.link.blocking.kmBand.toLocaleString('en-US')} km band. Exactly one vehicle fits: <Mono>{vin}</Mono>.
              </div>
            )}
            {r.withheldDecode && <div className="rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-rose-800">{r.withheldDecode}</div>}
          </div>
          <pre className="max-h-56 overflow-auto rounded-lg bg-slate-950 p-3 text-[11.5px] leading-relaxed text-slate-200">{JSON.stringify(r.payload, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

function VinCheck({ r }: { r: MatchedRecord }) {
  if (r.vinCheck === 'pass') return <Badge tone="green">check digit passes</Badge>;
  if (r.vinCheck === 'bad_shape') return <Badge tone="rose">not a valid VIN shape</Badge>;
  return (
    <Badge tone="rose">
      check digit fails: position 9 is {r.vinRaw?.[8]}, expected {r.checkExpected}
    </Badge>
  );
}
