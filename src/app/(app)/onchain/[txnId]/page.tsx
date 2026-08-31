import Link from 'next/link';
import { redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { onchainTransactions, wallets } from '@/db/schema';
import { assertCan, getAccess } from '@/lib/company';
import { excludeTransaction, postOnchainEntry, proposeOnchainEntry } from '@/lib/onchain/reconcile';
import { formatUnits } from '@/lib/onchain/provider';
import { fmt, shortDate } from '@/lib/format';
import { Card, EmptyState, PageHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function OnchainTxnPage({ params }: { params: Promise<{ txnId: string }> }) {
  const { txnId } = await params;
  const { company, role } = await getAccess();
  const cur = company.currency;
  const mayPost = role === 'OWNER' || role === 'ADMIN' || role === 'ACCOUNTANT';

  const [txn] = await db
    .select()
    .from(onchainTransactions)
    .where(and(eq(onchainTransactions.id, txnId), eq(onchainTransactions.companyId, company.id)))
    .limit(1);

  if (!txn) {
    return (
      <>
        <PageHeader title="Transfer not found" />
        <Card>
          <EmptyState title="No such transfer in this company" />
        </Card>
      </>
    );
  }

  const [wallet] = await db.select().from(wallets).where(eq(wallets.id, txn.walletId)).limit(1);
  const proposal = await proposeOnchainEntry(txn.id);

  async function doPost() {
    'use server';
    const access = await assertCan('post');
    const fresh = await proposeOnchainEntry(txnId);
    await postOnchainEntry({
      txnId,
      companyId: access.company.id,
      createdBy: `${access.user.name} <${access.user.email}>`,
      memo: fresh.memo,
      lines: fresh.lines.map((l) => ({
        accountId: l.accountId,
        debitCents: l.debitCents,
        creditCents: l.creditCents,
        description: l.description,
        contactId: l.contactId ?? null,
      })),
    });
    redirect('/onchain');
  }

  async function doExclude() {
    'use server';
    const access = await assertCan('enter');
    await excludeTransaction(access.company.id, txnId, 'Excluded by a reviewer as not an accounting event.');
    redirect('/onchain');
  }

  const blocking = proposal.findings.filter((f) => f.severity === 'BLOCK');

  return (
    <>
      <PageHeader
        title="Review transfer"
        subtitle={proposal.memo}
        action={
          <Link href="/onchain" className="btn-secondary">
            Back to the queue
          </Link>
        }
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card title="On-chain facts" className="lg:col-span-1">
          <dl className="divide-y divide-line text-sm">
            {[
              ['Chain', txn.chainId],
              ['Transaction', txn.txHash],
              ['Block', txn.blockNumber ? String(txn.blockNumber) : '—'],
              ['When', shortDate(txn.occurredAt)],
              ['Wallet', wallet?.label ?? '—'],
              ['Direction', txn.direction === 'IN' ? 'Received' : 'Sent'],
              ['Counterparty', txn.counterpartyAddress ?? '—'],
              ['Amount', `${formatUnits(txn.assetAmountRaw, txn.assetDecimals)} ${txn.assetSymbol}`],
              [
                'Price used',
                txn.priceMicros
                  ? `${(txn.priceMicros / 1_000_000).toFixed(6)} ${cur} · ${txn.priceSource ?? 'unknown source'}`
                  : 'none — cannot be valued',
              ],
              ['Value', fmt(txn.valueCents, cur)],
              ['Network fee', txn.feeCents ? fmt(txn.feeCents, cur) : '—'],
              ['Memo', txn.memo ?? '—'],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 px-5 py-2.5">
                <dt className="shrink-0 text-ink-muted">{k}</dt>
                <dd className="break-all text-right font-medium">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <div className="space-y-5 lg:col-span-2">
          <Card title="What the matcher concluded">
            <div className="px-5 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="badge bg-slate-800 text-white">{proposal.match.kind.replaceAll('_', ' ').toLowerCase()}</span>
                <span className="text-xxs text-ink-muted">confidence {proposal.match.confidence}%</span>
                <span className="ml-auto text-xxs text-ink-muted">deterministic — no model involved</span>
              </div>
              <p className="mt-2 text-sm">{proposal.match.reason}</p>

              {proposal.match.suggestions && proposal.match.suggestions.length > 0 && (
                <div className="mt-3 border-t border-line pt-3">
                  <p className="mb-1.5 text-xxs font-bold uppercase tracking-wide text-ink-muted">
                    What the ledger has done before
                  </p>
                  {proposal.match.suggestions.map((s) => (
                    <p key={s.accountId} className="text-xs text-ink-muted">
                      <span className="tabular">{s.code}</span> {s.name} — used {s.timesUsed}×, last {s.lastUsed ?? 'n/a'}
                      <span className="ml-1 text-ink-light">({s.confidence}%)</span>
                    </p>
                  ))}
                </div>
              )}
            </div>
          </Card>

          <Card title="Proposed entry">
            {proposal.lines.length === 0 ? (
              <EmptyState
                title="Nothing can be proposed yet"
                hint="Give the transfer a counterparty or a price, then re-run the matcher."
              />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Description</th>
                    <th className="num">Debit</th>
                    <th className="num">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {proposal.lines.map((l, i) => (
                    <tr key={i}>
                      <td className="whitespace-nowrap font-medium">
                        <span className="tabular text-ink-muted">{l.accountCode}</span> {l.accountName}
                      </td>
                      <td className="text-ink-muted">{l.description}</td>
                      <td className="num">{l.debitCents ? fmt(l.debitCents, cur) : ''}</td>
                      <td className="num">{l.creditCents ? fmt(l.creditCents, cur) : ''}</td>
                    </tr>
                  ))}
                  <tr className="bg-surface font-semibold">
                    <td colSpan={2} className="text-right text-xs uppercase tracking-wide text-ink-muted">
                      Totals
                    </td>
                    <td className="num">{fmt(proposal.lines.reduce((s, l) => s + l.debitCents, 0), cur)}</td>
                    <td className="num">{fmt(proposal.lines.reduce((s, l) => s + l.creditCents, 0), cur)}</td>
                  </tr>
                </tbody>
              </table>
            )}

            {(proposal.findings.length > 0 || proposal.warnings.length > 0) && (
              <div className="border-t border-line px-5 py-4">
                {proposal.findings.map((f, i) => (
                  <p
                    key={`f${i}`}
                    className={`mb-1.5 text-sm last:mb-0 ${
                      f.severity === 'BLOCK' ? 'text-red-700' : f.severity === 'WARN' ? 'text-amber-800' : 'text-ink-muted'
                    }`}
                  >
                    <span className="mr-2 font-semibold">{f.severity}</span>
                    {f.message}
                  </p>
                ))}
                {proposal.warnings.map((w, i) => (
                  <p key={`w${i}`} className="mb-1.5 text-sm text-amber-800 last:mb-0">
                    {w}
                  </p>
                ))}
              </div>
            )}

            {proposal.measurement && (
              <div className="border-t border-line bg-surface px-5 py-3">
                <p className="text-xs text-ink-muted">
                  <strong className="text-ink">{proposal.measurement.citation}</strong> — {proposal.measurement.basis}
                </p>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-4">
              <form action={doExclude}>
                <button className="btn-secondary text-xs">Not an accounting event</button>
              </form>
              <span className="text-xxs text-ink-muted">
                {proposal.postable
                  ? 'The transaction hash will be recorded on the journal entry.'
                  : blocking.length
                    ? 'Blocked — see above.'
                    : 'Cannot post yet.'}
              </span>
              <form action={doPost} className="ml-auto">
                <button className="btn-primary" disabled={!proposal.postable || !mayPost || Boolean(txn.journalEntryId)}>
                  {txn.journalEntryId ? 'Already posted' : 'Post to the ledger'}
                </button>
              </form>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
