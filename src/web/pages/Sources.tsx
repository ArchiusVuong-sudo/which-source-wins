import { useEffect, useState } from 'react';
import type { BuildSummary, ColumnMapping, DriftReport, DropSummary, SourceInfo } from '../../shared/types';
import { api, notifyChanged, useApi } from '../api';
import { Badge, Button, Card, ErrorBox, Loading, Mono, Notice, PageHeader, SourceChip, StatusChip, Td, Th, cx, fmtTime, shortSha } from '../components/ui';

interface SourcesResponse {
  sources: SourceInfo[];
  drops: DropSummary[];
}
interface DropResponse {
  drop: DropSummary;
  drift: DriftReport | null;
  nextMappingVersion: number;
}

export function SourcesPage() {
  const sources = useApi<SourcesResponse>('/sources');
  const builds = useApi<BuildSummary[]>('/builds');
  const [selected, setSelected] = useState<number | null>(null);
  const [message, setMessage] = useState<{ tone: 'green' | 'indigo' | 'amber'; text: string } | null>(null);
  const [busy, setBusy] = useState<'land' | 'rebuild' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newBuild, setNewBuild] = useState<number | null>(null);

  const drops = sources.data?.drops ?? [];
  const pending = drops.filter((d) => d.status === 'pending_rebuild').length;

  const land = async () => {
    setBusy('land');
    setError(null);
    try {
      const r = await api<{ landed: number; alreadyLanded: number }>('/land', { body: {} });
      setMessage({ tone: 'indigo', text: `Landing again: ${r.landed} new files, ${r.alreadyLanded} already landed under the same SHA-256 key. Nothing was added.` });
      notifyChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const rebuild = async () => {
    setBusy('rebuild');
    setError(null);
    try {
      const b = await api<BuildSummary>('/rebuild', { body: {} });
      setNewBuild(b.id);
      setSelected(null);
      setMessage({ tone: 'green', text: `Build #${b.id}: ${b.changed} changed, ${b.added} added, ${b.removed} removed. Full file ${b.full.rows} rows, delta ${b.delta.rows} rows.` });
      notifyChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <PageHeader
        title="Sources"
        description="Each drop lands under a content-addressed key, so landing the same file twice does nothing. A drop whose format changed is held here until someone approves its column mapping."
        actions={
          <>
            <Button onClick={land} busy={busy === 'land'}>
              Land files again
            </Button>
            <Button variant={pending > 0 ? 'primary' : 'secondary'} onClick={rebuild} busy={busy === 'rebuild'}>
              Rebuild{pending > 0 ? ` (${pending} staged)` : ''}
            </Button>
          </>
        }
      />
      {error && (
        <div className="mb-4">
          <ErrorBox message={error} />
        </div>
      )}
      {message && (
        <div className="mb-4">
          <Notice tone={message.tone}>{message.text}</Notice>
        </div>
      )}

      {sources.loading && !sources.data && <Loading />}
      {sources.error && <ErrorBox message={sources.error} onRetry={sources.reload} />}
      {sources.data && (
        <>
          <div className="mb-6 grid grid-cols-4 gap-4">
            {sources.data.sources.map((s) => {
              const ds = drops.filter((d) => d.source === s.id);
              return (
                <div key={s.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex items-center justify-between">
                    <SourceChip source={s.id} />
                    <Badge tone={s.kind === 'derived' ? 'violet' : 'slate'}>Tier {s.tier}</Badge>
                  </div>
                  <div className="mt-3 text-sm font-semibold text-slate-900">{s.label}</div>
                  <p className="mt-1 text-xs leading-relaxed text-slate-500">{s.description}</p>
                  <div className="mt-3 text-xs text-slate-500">
                    {s.id === 'vin_pattern' ? (
                      <span>Decoded per VIN at build time. A VIN that fails its check digit gets no facts.</span>
                    ) : (
                      <span className="tabular">
                        {ds.length} {ds.length === 1 ? 'drop' : 'drops'}, {ds.reduce((n, d) => n + d.rows, 0)} rows
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <Card title="Drops" subtitle="raw/<source>/<drop-date>/<sha256>.<ext>" padded={false} className="mb-6">
            <table className="w-full">
              <thead className="border-b border-slate-100 bg-slate-50/60">
                <tr>
                  <Th>Source</Th>
                  <Th>Drop</Th>
                  <Th>Key</Th>
                  <Th className="text-right">Rows</Th>
                  <Th>Mapping</Th>
                  <Th>Status</Th>
                  <Th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {drops.map((d) => (
                  <tr
                    key={d.id}
                    onClick={() => d.status === 'quarantined' && setSelected(d.id)}
                    className={cx(d.status === 'quarantined' && 'cursor-pointer hover:bg-rose-50/40', selected === d.id && 'bg-rose-50/60')}
                  >
                    <Td>
                      <SourceChip source={d.source} />
                    </Td>
                    <Td className="tabular">{d.dropDate}</Td>
                    <Td>
                      <Mono className="text-slate-500">
                        raw/{d.source}/{d.dropDate}/{shortSha(d.sha256)}
                      </Mono>
                    </Td>
                    <Td className="tabular text-right">{d.rows}</Td>
                    <Td className="text-xs text-slate-500">{d.source === 'registration' ? (d.mappingVersion ? `v${d.mappingVersion}` : 'none') : 'schema'}</Td>
                    <Td>
                      <StatusChip status={d.status} />
                    </Td>
                    <Td className="text-right">
                      {d.status === 'quarantined' && (
                        <span className="text-xs font-medium text-rose-700">{selected === d.id ? 'Reviewing' : 'Review drift'}</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {selected !== null && (
            <DriftPanel
              id={selected}
              onApproved={(m) => {
                setSelected(null);
                setMessage({ tone: 'amber', text: `Mapping v${m.version} approved and the drop is staged. Rebuild to publish it.` });
                notifyChanged();
              }}
            />
          )}
        </>
      )}

      <BuildHistory builds={builds.data} loading={builds.loading} error={builds.error} highlight={newBuild} />
    </div>
  );
}

function DriftPanel({ id, onApproved }: { id: number; onApproved: (m: ColumnMapping) => void }) {
  const d = useApi<DropResponse>(`/drops/${id}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [id]);

  useEffect(() => {
    if (d.data) document.getElementById('drift-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [d.data]);

  if (d.loading && !d.data) return <Loading label="Profiling columns" />;
  if (d.error) return <ErrorBox message={d.error} onRetry={d.reload} />;
  const r = d.data?.drift;
  if (!d.data || !r || !r.proposal) return null;
  const version = d.data.nextMappingVersion;
  const renamed = r.proposal.filter((p) => p.column && !r.expectedHeader.includes(p.column)).length;

  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      const columns = Object.fromEntries(r.proposal.filter((p) => p.column).map((p) => [p.field, p.column!]));
      const m = await api<ColumnMapping>(`/drops/${id}/approve`, { body: { columns, dateFormat: r.dateFormat, note: 'approved from the drift panel' } });
      onApproved(m);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      id="drift-panel"
      className="mb-6 scroll-mt-20 border-rose-200 ring-1 ring-rose-100"
      title={
        <span className="flex items-center gap-2">
          <SourceChip source={d.data.drop.source} long /> drop {d.data.drop.dropDate} is quarantined
        </span>
      }
      subtitle="The header does not match any approved mapping. Each column below is matched by what its values look like, not by its name."
      actions={
        <Button variant="primary" onClick={approve} busy={busy} disabled={r.blocking.length > 0 || !r.dateFormat}>
          Approve mapping v{version}
        </Button>
      }
    >
      {error && (
        <div className="mb-4">
          <ErrorBox message={error} />
        </div>
      )}
      <div className="mb-5 flex flex-wrap items-center gap-2 text-xs">
        <Badge tone="rose">{renamed} of {r.expectedHeader.length} columns renamed</Badge>
        {r.reordered && <Badge tone="rose">Column order changed</Badge>}
        {r.dateFormat && <Badge tone="rose">Dates now {r.dateFormat}</Badge>}
        {r.blocking.map((b) => (
          <Badge key={b} tone="amber">
            {b}
          </Badge>
        ))}
      </div>

      <div className="grid grid-cols-[280px_1fr] gap-6">
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Header diff</h3>
          <div className="overflow-hidden rounded-lg border border-slate-200">
            <table className="w-full text-xs">
              <thead className="bg-slate-50">
                <tr>
                  <Th>Mapping v{version - 1}</Th>
                  <Th>This file</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {r.proposal.map((p) => {
                  const was = r.expectedColumns?.[p.field] ?? p.field;
                  const wasPos = r.expectedHeader.indexOf(was) + 1;
                  const nowPos = p.column ? r.foundHeader.indexOf(p.column) + 1 : 0;
                  return (
                    <tr key={p.field}>
                      <td className="px-3 py-1.5">
                        <span className="font-mono text-rose-600 line-through decoration-rose-300">{was}</span>
                        <span className="tabular ml-1 text-slate-400">#{wasPos}</span>
                      </td>
                      <td className="px-3 py-1.5">
                        <span className="font-mono text-emerald-700">{p.column ?? '?'}</span>
                        {nowPos > 0 && <span className={cx('tabular ml-1', nowPos !== wasPos ? 'font-semibold text-rose-600' : 'text-slate-400')}>#{nowPos}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Notice tone="indigo">
            <span className="text-xs">{r.dateEvidence}</span>
          </Notice>
        </div>

        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Mapping proposal with value evidence</h3>
          <div className="overflow-hidden rounded-lg border border-slate-200">
            <table className="w-full">
              <thead className="bg-slate-50">
                <tr>
                  <Th>Our field</Th>
                  <Th>File column</Th>
                  <Th>Confidence</Th>
                  <Th>Evidence</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {r.proposal.map((p) => (
                  <tr key={p.field}>
                    <Td>
                      <Mono>{p.field}</Mono>
                    </Td>
                    <Td>{p.column ? <Mono className="font-semibold text-slate-900">{p.column}</Mono> : <Badge tone="amber">no match</Badge>}</Td>
                    <Td>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100">
                          <div className={cx('h-full rounded-full', p.confidence >= 0.95 ? 'bg-emerald-500' : 'bg-amber-500')} style={{ width: `${Math.round(p.confidence * 100)}%` }} />
                        </div>
                        <span className="tabular text-xs text-slate-500">{Math.round(p.confidence * 100)}%</span>
                      </div>
                    </Td>
                    <Td className="text-xs text-slate-600">
                      <ul className="space-y-0.5">
                        {p.evidence.map((e) => (
                          <li key={e}>{e}</li>
                        ))}
                      </ul>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Card>
  );
}

function BuildHistory({ builds, loading, error, highlight }: { builds: BuildSummary[] | null; loading: boolean; error: string | null; highlight: number | null }) {
  return (
    <Card title="Build history" subtitle="Each build ships the full golden set and a delta against the build before it, each with its row count and SHA-256." padded={false}>
      {loading && !builds && <Loading />}
      {error && (
        <div className="p-4">
          <ErrorBox message={error} />
        </div>
      )}
      {builds && (
        <table className="w-full">
          <thead className="border-b border-slate-100 bg-slate-50/60">
            <tr>
              <Th>Build</Th>
              <Th>When</Th>
              <Th>Trigger</Th>
              <Th>Rules</Th>
              <Th className="text-right">Vehicles</Th>
              <Th className="text-right">Changed</Th>
              <Th className="text-right">Added</Th>
              <Th className="text-right">Removed</Th>
              <Th>Full file</Th>
              <Th>Delta file</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {builds.map((b) => (
              <tr key={b.id} className={cx(b.id === highlight && 'row-new')}>
                <Td className="font-semibold text-slate-900">#{b.id}</Td>
                <Td className="tabular whitespace-nowrap text-xs text-slate-500">{fmtTime(b.createdAt)}</Td>
                <Td className="text-xs">{b.trigger}</Td>
                <Td className="tabular text-xs">v{b.ruleSetVersion}</Td>
                <Td className="tabular text-right">{b.vehicles}</Td>
                <Td className="tabular text-right">{b.changed}</Td>
                <Td className="tabular text-right">{b.added}</Td>
                <Td className="tabular text-right">{b.removed}</Td>
                <Td>
                  <FileCell id={b.id} kind="full" rows={b.full.rows} sha={b.full.sha256} />
                </Td>
                <Td>
                  <FileCell id={b.id} kind="delta" rows={b.delta.rows} sha={b.delta.sha256} />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function FileCell({ id, kind, rows, sha }: { id: number; kind: 'full' | 'delta'; rows: number; sha: string }) {
  return (
    <div className="text-xs">
      <a className="font-medium text-indigo-600 hover:underline" href={`/api/builds/${id}/${kind}.ndjson`}>
        {kind}.ndjson
      </a>
      <span className="tabular ml-1.5 text-slate-500">{rows} rows</span>
      <div title={sha}>
        <Mono className="text-[11px] text-slate-400">sha256 {sha.slice(0, 16)}…</Mono>
      </div>
    </div>
  );
}
