import { asc, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { standards } from '@/db/schema';
import { getCompany } from '@/lib/company';
import { Card, PageHeader } from '@/components/ui';

export default async function StandardsPage() {
  const company = await getCompany();
  const rows = await db.select().from(standards).where(eq(standards.isActive, true)).orderBy(asc(standards.topic), asc(standards.reference));

  const mine = rows.filter((r) => r.framework === company.framework);
  const other = rows.filter((r) => r.framework !== company.framework);
  const byTopic = new Map<string, typeof rows>();
  for (const r of mine) byTopic.set(r.topic, [...(byTopic.get(r.topic) ?? []), r]);

  const divergences = rows.filter((r) => r.divergenceNote);

  return (
    <>
      <PageHeader
        title="Standards rule-set"
        subtitle={
          <>
            The rules the assistant reasons from, keyed by framework. This is a <strong>curated decision aid</strong> —
            a citable summary of the treatments a mid-market group meets, not a reproduction of IFRS or the FASB
            Codification, and not a substitute for the standard or for professional judgement. It is stored as data, so
            your accountants can amend or extend it without a developer.
          </>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="card px-5 py-4">
          <div className="text-xxs font-bold uppercase tracking-wide text-ink-muted">Active framework</div>
          <div className="mt-1 text-2xl font-semibold">{company.framework === 'US_GAAP' ? 'US GAAP' : 'IFRS'}</div>
        </div>
        <div className="card px-5 py-4">
          <div className="text-xxs font-bold uppercase tracking-wide text-ink-muted">Rules in force here</div>
          <div className="mt-1 text-2xl font-semibold">{mine.length}</div>
        </div>
        <div className="card px-5 py-4">
          <div className="text-xxs font-bold uppercase tracking-wide text-ink-muted">Rules for the other framework</div>
          <div className="mt-1 text-2xl font-semibold">{other.length}</div>
        </div>
        <div className="card px-5 py-4">
          <div className="text-xxs font-bold uppercase tracking-wide text-ink-muted">Documented divergences</div>
          <div className="mt-1 text-2xl font-semibold text-amber-700">{divergences.length}</div>
        </div>
      </div>

      <Card title="Where IFRS and US GAAP part company" className="mb-5">
        <div className="divide-y divide-line">
          {divergences.slice(0, 12).map((s) => (
            <div key={s.id} className="px-5 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="badge bg-slate-800 text-white">{s.reference}</span>
                <span className="font-semibold">{s.title}</span>
                <span className="badge-neutral ml-auto">{s.topic.replaceAll('_', ' ').toLowerCase()}</span>
              </div>
              <p className="mt-1.5 text-sm text-amber-800">{s.divergenceNote}</p>
            </div>
          ))}
        </div>
      </Card>

      <div className="space-y-5">
        {Array.from(byTopic.entries()).map(([topic, list]) => (
          <Card key={topic} title={topic.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase())}>
            <div className="divide-y divide-line">
              {list.map((s) => (
                <div key={s.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="badge bg-slate-800 text-white">{s.reference}</span>
                    <span className="font-semibold">{s.title}</span>
                    {s.policyKey && <span className="badge-neutral ml-auto">policy: {s.policyKey}</span>}
                  </div>
                  <p className="mt-2 text-sm text-ink-muted">{s.requirement}</p>
                  <p className="mt-1.5 text-sm">{s.treatment}</p>
                  {s.entryTemplate && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {s.entryTemplate.map((t, i) => (
                        <span key={i} className="rounded border border-line bg-surface px-2 py-1 text-xxs">
                          <strong>{t.side}</strong> {t.subtype.replaceAll('_', ' ').toLowerCase()} — {t.note}
                        </span>
                      ))}
                    </div>
                  )}
                  {s.disclosure && <p className="mt-2 text-xs text-ink-muted">Disclosure: {s.disclosure}</p>}
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
