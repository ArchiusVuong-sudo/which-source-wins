import type { ReactNode } from 'react';
import type { DropStatus, FieldValue, SourceId } from '../../shared/types';

export const SOURCE_STYLE: Record<SourceId, { label: string; short: string; chip: string; dot: string }> = {
  vin_pattern: { label: 'VIN pattern decode (offline vPIC)', short: 'VIN pattern', chip: 'bg-violet-50 text-violet-700 ring-violet-200', dot: 'bg-violet-500' },
  registration: { label: 'Registration file', short: 'Registry', chip: 'bg-sky-50 text-sky-700 ring-sky-200', dot: 'bg-sky-500' },
  module_read: { label: 'Vehicle module reads', short: 'Module read', chip: 'bg-emerald-50 text-emerald-700 ring-emerald-200', dot: 'bg-emerald-500' },
  listing: { label: 'Dealer listings', short: 'Listing', chip: 'bg-amber-50 text-amber-800 ring-amber-200', dot: 'bg-amber-500' },
};

export function cx(...xs: (string | false | null | undefined)[]): string {
  return xs.filter(Boolean).join(' ');
}

export function SourceChip({ source, tier, count, long }: { source: SourceId; tier?: number | null; count?: number; long?: boolean }) {
  const s = SOURCE_STYLE[source];
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset', s.chip)}>
      <span className={cx('h-1.5 w-1.5 rounded-full', s.dot)} />
      {long ? s.label : s.short}
      {tier != null && <span className="opacity-60">T{tier}</span>}
      {count != null && <span className="tabular opacity-70">{count}</span>}
    </span>
  );
}

export function Badge({ tone = 'slate', children, title }: { tone?: 'slate' | 'green' | 'amber' | 'rose' | 'indigo' | 'violet'; children: ReactNode; title?: string }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-700 ring-slate-200',
    green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    amber: 'bg-amber-50 text-amber-800 ring-amber-200',
    rose: 'bg-rose-50 text-rose-700 ring-rose-200',
    indigo: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
    violet: 'bg-violet-50 text-violet-700 ring-violet-200',
  } as const;
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset', tones[tone])}>
      {children}
    </span>
  );
}

export function StatusChip({ status }: { status: DropStatus }) {
  if (status === 'loaded') return <Badge tone="green">Loaded</Badge>;
  if (status === 'pending_rebuild') return <Badge tone="amber">Staged, rebuild to publish</Badge>;
  return <Badge tone="rose">Quarantined</Badge>;
}

export function EmptyValue({ reason, compact }: { reason?: string; compact?: boolean }) {
  return (
    <span title={reason} className={cx('inline-flex items-center rounded border border-dashed border-slate-300 px-1.5 text-xs text-slate-400', compact ? 'py-0' : 'py-0.5')}>
      empty
    </span>
  );
}

export function fmtValue(v: FieldValue, field?: string): string {
  if (v === null) return '';
  if (typeof v === 'number') return field === 'modelYear' ? String(v) : v.toLocaleString('en-US') + (field === 'odometerKm' ? ' km' : '');
  return v;
}

export function Value({ value, field, reason }: { value: FieldValue; field?: string; reason?: string }) {
  if (value === null) return <EmptyValue reason={reason} />;
  return <span className="tabular">{fmtValue(value, field)}</span>;
}

export function Card({ id, title, subtitle, actions, children, className, padded = true }: { id?: string; title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section id={id} className={cx('rounded-xl border border-slate-200 bg-white shadow-sm', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-3.5">
          <div>
            {title && <h2 className="text-sm font-semibold text-slate-900">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  disabled,
  busy,
  type = 'button',
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  busy?: boolean;
  type?: 'button' | 'submit';
  title?: string;
}) {
  const styles = {
    primary: 'bg-indigo-600 text-white hover:bg-indigo-500 shadow-sm disabled:bg-indigo-300',
    secondary: 'bg-white text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 disabled:text-slate-400',
    danger: 'bg-white text-rose-700 ring-1 ring-inset ring-rose-300 hover:bg-rose-50 disabled:text-rose-300',
    ghost: 'text-slate-600 hover:bg-slate-100',
  } as const;
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled || busy}
      className={cx('inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed', styles[variant])}
    >
      {busy && <Spinner small />}
      {children}
    </button>
  );
}

export function Spinner({ small }: { small?: boolean }) {
  return <span className={cx('inline-block animate-spin rounded-full border-2 border-current border-r-transparent', small ? 'h-3.5 w-3.5' : 'h-5 w-5')} aria-label="loading" />;
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 px-5 py-10 text-sm text-slate-500">
      <Spinner /> {label}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
      <span>{message}</span>
      {onRetry && (
        <Button variant="danger" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function Notice({ tone = 'indigo', children }: { tone?: 'indigo' | 'green' | 'amber'; children: ReactNode }) {
  const tones = {
    indigo: 'border-indigo-200 bg-indigo-50 text-indigo-900',
    green: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    amber: 'border-amber-200 bg-amber-50 text-amber-900',
  } as const;
  return <div className={cx('rounded-lg border px-4 py-2.5 text-sm', tones[tone])}>{children}</div>;
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('font-mono text-[12.5px]', className)}>{children}</span>;
}

export const shortSha = (s: string) => `${s.slice(0, 12)}…`;

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function PageHeader({ title, description, actions }: { title: string; description: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex items-end justify-between gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-500">{description}</p>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return <th className={cx('px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500', className)}>{children}</th>;
}

export function Td({ children, className, colSpan }: { children?: ReactNode; className?: string; colSpan?: number }) {
  return (
    <td colSpan={colSpan} className={cx('px-3 py-2 align-top text-sm text-slate-700', className)}>
      {children}
    </td>
  );
}
