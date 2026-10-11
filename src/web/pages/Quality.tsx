import { useState } from 'react';
import type { PlanNode, QualityReport, ScaleReport } from '../../shared/types';
import { api, useApi } from '../api';
import { Badge, Button, Card, ErrorBox, Loading, Mono, Notice, PageHeader, SourceChip, Spinner, Td, Th, cx } from '../components/ui';
import { FIELD_LABEL } from '../labels';
import { href } from '../router';

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const ms = (x: number) => (x >= 100 ? `${Math.round(x).toLocaleString('en-US')} ms` : `${x.toFixed(x < 10 ? 2 : 1)} ms`);

export function QualityPage() {
  const q = useApi<QualityReport>('/quality');
  return (
    <div>
      <PageHeader title="Quality" description="How well the matcher and the rules do against the truth labels, and the cases they get wrong, by name." />
      {q.loading && !q.data && <Loading label="Scoring" />}
      {q.error && <ErrorBox message={q.error} onRetry={q.reload} />}
      {q.data && <Report r={q.data} />}
      <ScaleCheck />
    </div>
  );
}

function Report({ r }: { r: QualityReport }) {
  const p = r.pairs;
  return (
    <>
      <div className="mb-4">
        <Notice tone="amber">
          {r.note} Scored on {p.records} records in build #{r.buildId}.
        </Notice>
      </div>
      <div className="mb-6 grid grid-cols-4 gap-4">
        <Kpi label="Pairwise precision" value={pct(p.precision)} sub={`${p.tp} of ${p.predictedPairs} linked pairs are true`} />
        <Kpi label="Pairwise recall" value={pct(p.recall)} sub={`${p.tp} of ${p.truePairs} true pairs are linked`} />
        <Kpi label="F1" value={pct(p.f1)} sub={`${p.fp} false merge pairs, ${p.fn} missed pairs`} />
        <Kpi label="Cannot-link violations" value={String(r.cannotLinkViolations)} sub="vehicles holding two different valid VINs" good={r.cannotLinkViolations === 0} />
      </div>

      <Card className="mb-6" title="Named errors" subtitle="Every record the matcher placed wrongly, under its planted case, with the records behind it." padded={false}>
        <div className="divide-y divide-slate-100">
          {r.errors.map((e) => (
            <div key={`${e.kind}-${e.records[0]?.recordId}`} className="px-5 py-4">
              <div className="mb-1 flex items-center gap-2">
                <Badge tone={e.kind === 'false_merge' ? 'rose' : 'amber'}>{e.kind === 'false_merge' ? 'False merge' : 'Missed match'}</Badge>
                <span className="text-sm font-semibold text-slate-900">{e.caseLabel}</span>
                <span className="tabular text-xs text-slate-400">
                  {e.pairs} {e.kind === 'false_merge' ? 'false' : 'missed'} {e.pairs === 1 ? 'pair' : 'pairs'}
                </span>
              </div>
              <p className="mb-2 text-sm text-slate-600">{e.explanation}</p>
              <table className="w-full rounded-lg border border-slate-100">
                <tbody className="divide-y divide-slate-100">
                  {e.records.map((x, i) => (
                    <tr key={x.recordId} className={cx(i === 0 && 'bg-slate-50/80')}>
                      <Td className="w-56">
                        <Mono className={cx(i === 0 && 'font-semibold text-slate-900')}>{x.recordId}</Mono>
                      </Td>
                      <Td className="w-32">
                        <SourceChip source={x.source} />
                      </Td>
                      <Td className="w-48">{x.vinRaw ? <Mono>{x.vinRaw}</Mono> : <span className="text-xs text-slate-400">no VIN</span>}</Td>
                      <Td className="text-xs">{x.summary}</Td>
                      <Td className="w-64 text-xs">
                        truth{' '}
                        <a className="font-mono text-indigo-700 hover:underline" href={href({ page: 'vehicle', vin: x.trueVin })}>
                          {x.trueVin}
                        </a>
                        {x.predictedVin !== x.trueVin && (
                          <div className="text-rose-700">
                            linked to <Mono>{x.predictedVin ?? 'nothing'}</Mono>
                          </div>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {r.errors.length === 0 && <div className="px-5 py-8 text-center text-sm text-slate-400">No matching errors on this set.</div>}
        </div>
      </Card>

      <Card className="mb-6" title="Field accuracy" subtitle="Golden values against the truth labels. Empty is counted apart from wrong: an empty field is a gap, a wrong one is a claim." padded={false}>
        <table className="w-full">
          <thead className="border-b border-slate-100 bg-slate-50/60">
            <tr>
              <Th>Field</Th>
              <Th className="w-1/2">Split</Th>
              <Th className="text-right">Correct</Th>
              <Th className="text-right">Wrong</Th>
              <Th className="text-right">Empty</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {r.fieldAccuracy.map(({ field, score: s }) => (
              <tr key={field}>
                <Td className="font-medium">{FIELD_LABEL[field]}</Td>
                <Td>
                  <div className="flex h-2 overflow-hidden rounded-full bg-slate-100">
                    <div className="bg-emerald-500" style={{ width: `${(s.correct / s.total) * 100}%` }} />
                    <div className="bg-rose-500" style={{ width: `${(s.wrong / s.total) * 100}%` }} />
                  </div>
                </Td>
                <Td className="tabular text-right">{s.correct}</Td>
                <Td className={cx('tabular text-right', s.wrong > 0 && 'font-semibold text-rose-700')}>{s.wrong}</Td>
                <Td className="tabular text-right text-slate-500">{s.empty}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function Kpi({ label, value, sub, good }: { label: string; value: string; sub: string; good?: boolean }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className={cx('tabular mt-1 text-2xl font-semibold tracking-tight', good ? 'text-emerald-600' : 'text-slate-900')}>{value}</div>
      <div className="mt-1 text-xs text-slate-500">{sub}</div>
    </div>
  );
}

function ScaleCheck() {
  const [report, setReport] = useState<ScaleReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await api<ScaleReport>('/quality/scale', { body: { rows: 1_000_000 } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const speedup = report ? report.withoutIndex.executionMs / Math.max(0.001, report.withIndex.executionMs) : 0;
  return (
    <Card
      title="Scale check"
      subtitle="The matcher's blocking query (VIN-less listings on one lot against every candidate) on generated rows, in a separate in-memory Postgres in a worker thread."
      actions={
        <Button variant="primary" onClick={run} busy={busy}>
          Run scale check (1,000,000 rows)
        </Button>
      }
    >
      {error && <ErrorBox message={error} />}
      {busy && !report && (
        <div className="flex items-center gap-3 text-sm text-slate-500">
          <Spinner /> Generating 1,000,000 rows and planning the query twice. This takes a few seconds.
        </div>
      )}
      {!busy && !report && !error && <p className="text-sm text-slate-400">Not run yet. The numbers come from Postgres EXPLAIN (ANALYZE, BUFFERS) on this machine.</p>}
      {report && (
        <div>
          <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-slate-600">
            <span className="tabular">
              <b>{report.rows.toLocaleString('en-US')}</b> rows generated in {ms(report.insertMs)}
            </span>
            <span className="tabular">index built in {ms(report.indexMs)}</span>
            <span className="tabular">
              {report.withIndex.resultRows} candidate pairs{report.withoutIndex.resultRows === report.withIndex.resultRows ? ', same result both ways' : ''}
            </span>
            <Badge tone="green">{speedup >= 10 ? Math.round(speedup).toLocaleString('en-US') : speedup.toFixed(1)}x faster with the index</Badge>
          </div>
          <pre className="mb-4 overflow-auto rounded-lg bg-slate-50 p-3 font-mono text-[11.5px] text-slate-600">{report.query}</pre>
          <div className="grid grid-cols-2 gap-4">
            {[report.withoutIndex, report.withIndex].map((run) => (
              <div key={run.label} className="rounded-lg border border-slate-200">
                <div className="flex items-baseline justify-between border-b border-slate-100 px-4 py-2.5">
                  <span className="text-sm font-semibold text-slate-800">{run.label}</span>
                  <span className="tabular text-lg font-semibold text-slate-900">
                    {ms(run.executionMs)} <span className="text-xs font-normal text-slate-400">execution, {ms(run.planningMs)} planning</span>
                  </span>
                </div>
                <div className="p-3">
                  <PlanTree node={run.plan} depth={0} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function PlanTree({ node, depth }: { node: PlanNode; depth: number }) {
  return (
    <div>
      <div className="flex items-start gap-2 py-1 text-xs" style={{ paddingLeft: depth * 16 }}>
        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
        <div className="min-w-0">
          <div>
            <span className="font-semibold text-slate-800">{node.nodeType}</span>
            {node.index ? <span className="text-violet-700"> using {node.index}</span> : node.relation ? <span className="text-slate-500"> on {node.relation}</span> : null}
            <span className="tabular ml-2 text-slate-400">
              rows {node.actualRows.toLocaleString('en-US')}
              {node.loops > 1 ? ` x ${node.loops.toLocaleString('en-US')} loops` : ''} · {ms(node.actualTotalMs)} · buffers {(node.sharedHit + node.sharedRead).toLocaleString('en-US')}
            </span>
          </div>
          {node.detail && <div className="truncate font-mono text-[10.5px] text-slate-400">{node.detail}</div>}
        </div>
      </div>
      {node.children.map((c, i) => (
        <PlanTree key={i} node={c} depth={depth + 1} />
      ))}
    </div>
  );
}
