import Link from 'next/link';
import { getCompany } from '@/lib/company';
import { generalLedger } from '@/lib/reports';
import { fmt, shortDate } from '@/lib/format';
import { Card, EmptyState, PageHeader } from '@/components/ui';

export default async function JournalPage() {
  const company = await getCompany();
  const to = new Date();
  const from = new Date(to.getFullYear() - 2, 0, 1);
  const entries = await generalLedger(company.id, { from, to, limit: 120 });

  return (
    <>
      <PageHeader
        title="Journal entries"
        subtitle="Every posting in the ledger, whatever produced it. Entries are reversed, never deleted."
        action={
          <Link href="/accounting/journal/new" className="btn-primary">
            New journal entry
          </Link>
        }
      />

      {entries.length === 0 ? (
        <Card>
          <EmptyState title="No entries yet" />
        </Card>
      ) : (
        <div className="space-y-3">
          {entries.map((e) => {
            const debit = e.lines.reduce((s, l) => s + l.debitCents, 0);
            return (
              <Card key={e.id}>
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
                  <div className="flex items-center gap-3">
                    <span className="font-semibold text-brand-dark">{e.entryNo}</span>
                    <span className="text-ink-muted">{shortDate(e.date)}</span>
                    <span className="text-ink">{e.memo}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {e.aiAssisted && <span className="badge-ai">AI drafted, human posted</span>}
                    <span className="badge-neutral">{e.source.replaceAll('_', ' ').toLowerCase()}</span>
                    {(e.standardRefs ?? []).map((r) => (
                      <span key={r} className="badge bg-slate-100 text-slate-700">
                        {r}
                      </span>
                    ))}
                    {e.settlementRail && (
                      <span
                        className="badge bg-slate-800 text-white"
                        title={
                          e.settlementRef?.txHash
                            ? `${e.settlementRef.chainId ?? 'chain'} · ${e.settlementRef.txHash}`
                            : e.settlementRef?.reference ?? ''
                        }
                      >
                        {e.settlementRail === 'ONCHAIN' && e.settlementRef?.txHash
                          ? `${e.settlementRef.chainId ?? 'chain'} ${e.settlementRef.txHash.slice(0, 10)}…`
                          : e.settlementRail.toLowerCase()}
                      </span>
                    )}
                    <span className="tabular text-sm font-semibold">{fmt(debit, company.currency)}</span>
                  </div>
                </div>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Description</th>
                      <th>Name</th>
                      <th className="num">Debit</th>
                      <th className="num">Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {e.lines.map((l, i) => (
                      <tr key={i}>
                        <td className="font-medium">
                          <span className="tabular text-ink-muted">{l.accountCode}</span> {l.accountName}
                        </td>
                        <td className="text-ink-muted">{l.description ?? '—'}</td>
                        <td className="text-ink-muted">{l.contactName ?? '—'}</td>
                        <td className="num">{l.debitCents ? fmt(l.debitCents, company.currency) : ''}</td>
                        <td className="num">{l.creditCents ? fmt(l.creditCents, company.currency) : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
