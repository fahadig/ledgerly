import Link from 'next/link';
import type { ReactNode } from 'react';

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-5 flex items-end justify-between gap-6">
      <div>
        <h2 className="text-2xl font-semibold text-ink">{title}</h2>
        {subtitle && <p className="mt-1 max-w-3xl text-sm text-ink-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Card({ title, action, children, className = '' }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <div className="card-head">
          {title && <h3 className="card-title">{title}</h3>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
  href,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
  href?: string;
}) {
  const toneClass = {
    neutral: 'text-ink',
    good: 'text-brand-dark',
    warn: 'text-amber-700',
    bad: 'text-red-700',
  }[tone];

  const body = (
    <div className="card h-full px-5 py-4 transition-shadow hover:shadow-sm">
      <div className="text-xxs font-bold uppercase tracking-wide text-ink-muted">{label}</div>
      <div className={`mt-1.5 tabular text-2xl font-semibold ${toneClass}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-ink-muted">{hint}</div>}
    </div>
  );

  return href ? <Link href={href}>{body}</Link> : body;
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="px-5 py-12 text-center">
      <p className="text-sm font-semibold text-ink">{title}</p>
      {hint && <p className="mt-1 text-sm text-ink-muted">{hint}</p>}
    </div>
  );
}

const TRACK = 160;

/** A column chart that needs no chart library and prints correctly. */
export function BarSeries({
  data,
  currency,
}: {
  data: { label: string; income: number; expenses: number }[];
  currency: string;
}) {
  const max = Math.max(1, ...data.flatMap((d) => [d.income, d.expenses]));
  const fmtShort = (n: number) =>
    Math.abs(n) >= 100_000_00
      ? `${(n / 100_000_00).toFixed(1)}m`
      : Math.abs(n) >= 100_000
        ? `${(n / 100_000).toFixed(0)}k`
        : (n / 100).toFixed(0);

  return (
    <div className="px-5 py-4">
      <div className="mb-3 flex items-center gap-4 text-xxs text-ink-muted">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-brand" /> Income
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-ink-light" /> Expenses
        </span>
        <span className="ml-auto">{currency}</span>
      </div>
      {/* Pixel heights, not percentages: a percentage height needs a definite
          parent height, which a flex child does not reliably have. */}
      <div className="flex items-end gap-2" style={{ height: TRACK + 20 }}>
        {data.map((d) => (
          <div key={d.label} className="flex flex-1 flex-col items-center gap-1">
            <div className="flex w-full items-end justify-center gap-0.5" style={{ height: TRACK }}>
              <div
                className="w-1/2 rounded-t bg-brand"
                style={{ height: Math.max(2, Math.round((d.income / max) * TRACK)) }}
                title={`Income ${fmtShort(d.income)}`}
              />
              <div
                className="w-1/2 rounded-t bg-ink-light"
                style={{ height: Math.max(2, Math.round((d.expenses / max) * TRACK)) }}
                title={`Expenses ${fmtShort(d.expenses)}`}
              />
            </div>
            <div className="text-xxs text-ink-muted">{d.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
