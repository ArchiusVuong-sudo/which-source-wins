import { useEffect, useState } from 'react';
import type { BuildSummary, Decision, FieldName, FieldRule, RulePreview, RuleSet, Score, SourceId } from '../../shared/types';
import { api, notifyChanged, useApi } from '../api';
import { Badge, Button, Card, EmptyValue, ErrorBox, Loading, Mono, Notice, PageHeader, SOURCE_STYLE, SourceChip, Td, Th, cx, fmtTime } from '../components/ui';
import { FIELD_LABEL } from '../labels';
import { href, navigate } from '../router';

interface RulesResponse {
  rules: RuleSet;
  decisions: Decision[];
}

export function RulesPage({ field }: { field: string }) {
  const r = useApi<RulesResponse>('/rules');
  const selected = (r.data && field in r.data.rules.fields ? field : 'trim') as FieldName;

  return (
    <div>
      <PageHeader
        title="Rules"
        description="Which source wins each field, written down and versioned. A proposed change is replayed on every vehicle inside a transaction that always rolls back, and scored against the synthetic truth before anyone accepts or rejects it."
      />
      {r.loading && !r.data && <Loading />}
      {r.error && <ErrorBox message={r.error} onRetry={r.reload} />}
      {r.data && (
        <>
          <div className="mb-6 grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-6">
            <Card title={`Rule set v${r.data.rules.version}`} subtitle="Click a rule to edit its source order." padded={false}>
              <table className="w-full">
                <thead className="border-b border-slate-100 bg-slate-50/60">
                  <tr>
                    <Th>Field</Th>
                    <Th>Rule</Th>
                    <Th>Source order</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(Object.entries(r.data.rules.fields) as [FieldName, FieldRule][]).map(([name, rule]) => (
                    <tr
                      key={name}
                      onClick={() => navigate({ page: 'rules', field: name }, true)}
                      className={cx('cursor-pointer', name === selected ? 'bg-indigo-50/70' : 'hover:bg-slate-50')}
                    >
                      <Td className="font-medium text-slate-800">{FIELD_LABEL[name]}</Td>
                      <Td className="whitespace-nowrap">
                        <Mono className="text-[11.5px]">
                          {rule.id} <span className="text-slate-400">v{rule.version}</span>
                        </Mono>
                        {rule.kind === 'latest_reading' && <div className="text-[11px] text-slate-400">newest reading, rollback guarded</div>}
                      </Td>
                      <Td>
                        <div className="flex flex-wrap items-center gap-1">
                          {rule.sources.map((s, i) => (
                            <span key={s} className="flex items-center gap-1">
                              {i > 0 && <span className="text-xs text-slate-300">›</span>}
                              <SourceChip source={s} />
                            </span>
                          ))}
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <RuleEditor key={`${selected}-${r.data.rules.version}`} field={selected} rule={r.data.rules.fields[selected]} onDecided={() => r.reload()} />
          </div>
          <DecisionLog decisions={r.data.decisions} />
        </>
      )}
    </div>
  );
}

function RuleEditor({ field, rule, onDecided }: { field: FieldName; rule: FieldRule; onDecided: () => void }) {
  const [order, setOrder] = useState<SourceId[]>(rule.sources);
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [busy, setBusy] = useState<'preview' | 'accepted' | 'rejected' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ decision: Decision; build: BuildSummary | null } | null>(null);
  const changed = order.join() !== rule.sources.join();
  useEffect(() => setPreview(null), [order]);

  const add = (s: SourceId) => setOrder((o) => [...o, s]);
  const remove = (s: SourceId) => setOrder((o) => (o.length > 1 ? o.filter((x) => x !== s) : o));
  const move = (i: number, d: -1 | 1) =>
    setOrder((o) => {
      const n = [...o];
      const j = i + d;
      if (j < 0 || j >= n.length) return o;
      [n[i], n[j]] = [n[j]!, n[i]!];
      return n;
    });

  const runPreview = async () => {
    setBusy('preview');
    setError(null);
    setDone(null);
    try {
      setPreview(await api<RulePreview>('/rules/preview', { body: { field, sources: order } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const decide = async (decision: 'accepted' | 'rejected') => {
    setBusy(decision);
    setError(null);
    try {
      const res = await api<{ decision: Decision; build: BuildSummary | null }>('/rules/decide', { body: { field, sources: order, decision, reason } });
      setDone(res);
      setPreview(null);
      if (decision === 'rejected') setOrder(rule.sources);
      notifyChanged();
      onDecided();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const available = rule.allowedSources.filter((s) => !order.includes(s));
  const reasonOk = reason.trim().length >= 3;

  return (
    <Card title={`Edit: ${FIELD_LABEL[field]}`} subtitle={rule.note}>
      <div className="mb-4">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Source order (first source with a value wins)</div>
        <div className="flex flex-wrap items-center gap-2">
          {order.map((s, i) => (
            <div key={s} className="flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 py-1 pr-1 pl-2">
              <span className="tabular text-xs text-slate-400">{i + 1}</span>
              <SourceChip source={s} long />
              <button className="rounded px-1 text-slate-400 hover:bg-white hover:text-slate-700 disabled:opacity-30" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">
                ↑
              </button>
              <button className="rounded px-1 text-slate-400 hover:bg-white hover:text-slate-700 disabled:opacity-30" onClick={() => move(i, 1)} disabled={i === order.length - 1} aria-label="Move down">
                ↓
              </button>
              <button className="rounded px-1 text-slate-400 hover:bg-white hover:text-rose-600 disabled:opacity-30" onClick={() => remove(s)} disabled={order.length === 1} aria-label={`Remove ${s}`}>
                ×
              </button>
            </div>
          ))}
          {available.map((s) => (
            <button key={s} onClick={() => add(s)} className="rounded-lg border border-dashed border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:border-indigo-400 hover:text-indigo-700">
              + {s === 'listing' && field === 'trim' ? 'Seller text' : SOURCE_STYLE[s].short}
            </button>
          ))}
          {rule.allowedSources.length === 1 && <span className="text-xs text-slate-400">Only one source may set this field.</span>}
        </div>
      </div>
      <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500" htmlFor="reason">
        Reason (required to accept or reject)
      </label>
      <textarea
        id="reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        placeholder="Why this change, or why not"
        className="mb-3 w-full resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
      />
      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={runPreview} disabled={!changed} busy={busy === 'preview'}>
          Preview
        </Button>
        <Button variant="danger" onClick={() => decide('rejected')} disabled={!preview || !reasonOk} busy={busy === 'rejected'} title={!reasonOk ? 'Type a reason first' : undefined}>
          Reject
        </Button>
        <Button onClick={() => decide('accepted')} disabled={!preview || !reasonOk} busy={busy === 'accepted'} title={!reasonOk ? 'Type a reason first' : undefined}>
          Accept and rebuild
        </Button>
        {!changed && <span className="text-xs text-slate-400">Change the source order to preview.</span>}
        {preview && !reasonOk && <span className="text-xs text-amber-700">Type a reason to accept or reject.</span>}
      </div>
      {error && (
        <div className="mt-4">
          <ErrorBox message={error} />
        </div>
      )}
      {done && (
        <div className="mt-4">
          <Notice tone={done.decision.decision === 'accepted' ? 'green' : 'amber'}>
            Decision #{done.decision.id}: {done.decision.decision} {done.decision.proposedRuleId} v{done.decision.proposedVersion} (proposed over {done.decision.ruleId} v{done.decision.fromVersion}). Reason: "{done.decision.reason}".
            {done.build ? ` Build #${done.build.id} written: ${done.build.changed} changed, delta ${done.build.delta.rows} rows.` : ' The rule stays as it is.'}
          </Notice>
        </div>
      )}
      {preview && <PreviewResult p={preview} />}
    </Card>
  );
}

function ScoreBar({ label, s }: { label: string; s: Score }) {
  const w = (n: number) => `${(n / Math.max(1, s.total)) * 100}%`;
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-xs font-semibold text-slate-600">{label}</span>
        <span className="tabular text-xs text-slate-400">{s.total} vehicles</span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-slate-100">
        <div className="bg-emerald-500" style={{ width: w(s.correct) }} />
        <div className="bg-rose-500" style={{ width: w(s.wrong) }} />
      </div>
      <div className="tabular mt-2 flex gap-4 text-xs">
        <span className="text-emerald-700">
          <b className="text-base">{s.correct}</b> correct
        </span>
        <span className={s.wrong > 0 ? 'text-rose-700' : 'text-slate-500'}>
          <b className="text-base">{s.wrong}</b> wrong
        </span>
        <span className="text-slate-500">
          <b className="text-base">{s.empty}</b> empty
        </span>
      </div>
    </div>
  );
}

function PreviewResult({ p }: { p: RulePreview }) {
  return (
    <div className="mt-5 border-t border-slate-100 pt-4">
      <Notice tone="indigo">
        Replayed on every vehicle inside a transaction that rolled back. Nothing was saved. {p.changes.length} vehicles would change {FIELD_LABEL[p.field].toLowerCase()}.
      </Notice>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <ScoreBar label={`Now: ${p.from.id} v${p.from.version}`} s={p.before} />
        <ScoreBar label={`Proposed: ${p.to.id} v${p.to.version}`} s={p.after} />
      </div>
      <div className="mt-4 max-h-80 overflow-auto rounded-lg border border-slate-200">
        <table className="w-full">
          <thead className="sticky top-0 bg-slate-50">
            <tr>
              <Th>Vehicle</Th>
              <Th>Now</Th>
              <Th>Proposed</Th>
              <Th>Truth</Th>
              <Th>Verdict</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {[...p.changes]
              .sort((a, b) => (a.verdict === b.verdict ? a.title.localeCompare(b.title) : a.verdict === 'wrong' ? -1 : 1))
              .map((c) => (
                <tr key={c.vin} className={cx(c.verdict === 'wrong' && 'bg-rose-50/50')}>
                  <Td className="text-xs">
                    <a className="font-medium text-slate-800 hover:underline" href={href({ page: 'vehicle', vin: c.vin })}>
                      {c.title}
                    </a>
                    <div>
                      <Mono className="text-[11px] text-slate-400">{c.vin}</Mono>
                    </div>
                  </Td>
                  <Td>{c.before === null ? <EmptyValue compact /> : String(c.before)}</Td>
                  <Td>
                    {c.after === null ? <EmptyValue compact /> : <span className="font-medium">{String(c.after)}</span>}
                    {c.afterSource && <span className="ml-1.5">{<SourceChip source={c.afterSource} />}</span>}
                  </Td>
                  <Td className="text-slate-500">{c.truth === null ? '-' : String(c.truth)}</Td>
                  <Td>
                    <Badge tone={c.verdict === 'correct' ? 'green' : c.verdict === 'wrong' ? 'rose' : 'slate'}>{c.verdict}</Badge>
                  </Td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DecisionLog({ decisions }: { decisions: Decision[] }) {
  return (
    <Card title="Decision log" subtitle="Every accepted or rejected rule change, with its reason and the scores it was decided on." padded={false}>
      {decisions.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-slate-400">No decisions yet. Preview a change, then accept or reject it with a reason.</div>
      ) : (
        <table className="w-full">
          <thead className="border-b border-slate-100 bg-slate-50/60">
            <tr>
              <Th>#</Th>
              <Th>When</Th>
              <Th>Decision</Th>
              <Th>Rule</Th>
              <Th>Proposed order</Th>
              <Th>Score before → after</Th>
              <Th>Reason</Th>
              <Th>Build</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {decisions.map((d) => (
              <tr key={d.id}>
                <Td className="font-semibold">{d.id}</Td>
                <Td className="tabular whitespace-nowrap text-xs text-slate-500">{fmtTime(d.at)}</Td>
                <Td>
                  <Badge tone={d.decision === 'accepted' ? 'green' : 'rose'}>{d.decision}</Badge>
                </Td>
                <Td>
                  <Mono className="text-[11.5px]">
                    {d.proposedRuleId} v{d.proposedVersion}
                  </Mono>
                  <div className="text-[11px] text-slate-400">
                    over {d.ruleId} v{d.fromVersion}
                  </div>
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {d.proposedSources.map((s) => (
                      <SourceChip key={s} source={s} />
                    ))}
                  </div>
                </Td>
                <Td className="tabular text-xs">
                  {d.before.correct}/{d.before.wrong}/{d.before.empty} → {d.after.correct}/{d.after.wrong}/{d.after.empty}
                  <div className="text-[11px] text-slate-400">correct/wrong/empty</div>
                </Td>
                <Td className="text-sm">"{d.reason}"</Td>
                <Td className="text-xs">{d.buildId ? `#${d.buildId}` : '-'}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
