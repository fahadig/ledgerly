import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { assertCan, getAccess } from '@/lib/company';
import {
  digitalAssetMeasurement,
  importTransfers,
  listWallets,
  onchainSummary,
  reconciliationQueue,
  runMatcher,
} from '@/lib/onchain/reconcile';
import { formatUnits, parseTransferCsv, CSV_TEMPLATE } from '@/lib/onchain/provider';
import { fmt, shortDate } from '@/lib/format';
import { Card, EmptyState, PageHeader, StatTile } from '@/components/ui';

export const dynamic = 'force-dynamic';

const statusClass = (s: string) =>
  s === 'RECONCILED' ? 'badge-paid'
  : s === 'SUGGESTED' ? 'badge-open'
  : s === 'INTERNAL_TRANSFER' ? 'badge-neutral'
  : s === 'EXCLUDED' ? 'badge-neutral'
  : 'badge-overdue';

export default async function OnchainPage({
  searchParams,
}: {
  searchParams: Promise<{ imported?: string; matched?: string; error?: string }>;
}) {
  const { company, role } = await getAccess();
  const params = await searchParams;
  const cur = company.currency;
  const mayPost = role === 'OWNER' || role === 'ADMIN' || role === 'ACCOUNTANT';

  const [summary, walletRows, queue, measurement] = await Promise.all([
    onchainSummary(company.id),
    listWallets(company.id),
    reconciliationQueue(company.id),
    digitalAssetMeasurement(company.id),
  ]);

  async function doImport(formData: FormData) {
    'use server';
    const access = await assertCan('enter');
    const walletId = String(formData.get('walletId') ?? '');
    const csv = String(formData.get('csv') ?? '');

    if (!walletId || csv.trim().length < 20) {
      revalidatePath('/onchain');
      return;
    }

    const parsed = parseTransferCsv(csv);
    if (!parsed.transfers.length) {
      const msg = parsed.errors[0] ?? 'Nothing could be read from that file.';
      revalidatePath('/onchain');
      throw new Error(msg);
    }

    const result = await importTransfers({
      companyId: access.company.id,
      walletId,
      transfers: parsed.transfers,
    });
    await runMatcher(access.company.id);
    revalidatePath('/onchain');
  }

  async function doMatch() {
    'use server';
    const access = await assertCan('enter');
    await runMatcher(access.company.id);
    revalidatePath('/onchain');
  }

  return (
    <>
      <PageHeader
        title="On-chain"
        subtitle={
          <>
            A transaction hash is a settlement reference, the same as a bank reference — so an on-chain
            transfer reconciles through the same queue, posts through the same engine, and carries its
            proof on the journal entry itself. There is no separate crypto sub-ledger to sync back.
          </>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatTile label="Wallets tracked" value={String(summary.wallets)} />
        <StatTile
          label="Needs categorising"
          value={String(summary.unmatched)}
          hint={summary.unmatchedValueCents ? fmt(summary.unmatchedValueCents, cur) : 'nothing waiting'}
          tone={summary.unmatched > 0 ? 'warn' : 'neutral'}
        />
        <StatTile label="Proposed" value={String(summary.suggested)} tone={summary.suggested > 0 ? 'good' : 'neutral'} />
        <StatTile label="Internal movements" value={String(summary.internal)} hint="not income or expense" />
        <StatTile label="Posted to the ledger" value={String(summary.reconciled)} tone="good" />
      </div>

      {measurement && (
        <div className="card mb-5 border-l-4 border-brand p-5">
          <div className="flex flex-wrap items-baseline gap-2">
            <h3 className="text-base font-semibold">Measurement basis for digital assets</h3>
            <span className="badge bg-slate-800 text-white">{measurement.citation}</span>
            <span className="ml-auto text-xxs text-ink-muted">
              {company.framework === 'US_GAAP' ? 'US GAAP' : 'IFRS'} · policy {measurement.policy}
            </span>
          </div>
          <p className="mt-2 max-w-3xl text-sm text-ink-muted">{measurement.basis}</p>
          <p className="mt-2 max-w-3xl text-xs text-ink-light">
            This is a genuine divergence, not a preference. The same token is carried at cost under IFRS
            and at fair value through profit or loss under US GAAP — so a group reporting under both
            holds it at two different amounts, and the consolidation has to know which.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <Card title="Wallets" className="xl:col-span-2">
          {walletRows.length === 0 ? (
            <EmptyState
              title="No wallets registered"
              hint="Registering a wallet is what makes a transfer ours — a movement between two registered wallets is internal, not income."
            />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Chain</th>
                  <th>Address</th>
                  <th>Custody</th>
                </tr>
              </thead>
              <tbody>
                {walletRows.map((w) => (
                  <tr key={w.id}>
                    <td className="font-medium">{w.label}</td>
                    <td className="text-ink-muted">{w.chainId}</td>
                    <td className="tabular text-xs text-ink-muted">
                      {w.address.length > 20 ? `${w.address.slice(0, 12)}…${w.address.slice(-6)}` : w.address}
                    </td>
                    <td>
                      <span className="badge-neutral">{w.custody.replaceAll('_', ' ').toLowerCase()}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Import transfers">
          <form action={doImport} className="px-5 py-4">
            <label className="label" htmlFor="walletId">
              Wallet
            </label>
            <select id="walletId" name="walletId" className="input mb-3" required>
              {walletRows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label} · {w.chainId}
                </option>
              ))}
            </select>

            <label className="label" htmlFor="csv">
              Paste an exported transfer file (CSV)
            </label>
            <textarea
              id="csv"
              name="csv"
              className="input min-h-[110px] resize-y font-mono text-xxs"
              placeholder={CSV_TEMPLATE}
              defaultValue=""
            />
            <p className="mt-2 text-xxs text-ink-muted">
              Re-importing the same file inserts nothing — every transfer is keyed by chain, hash and log
              index, so a feed that arrives twice cannot be posted twice.
            </p>

            <div className="mt-3 flex items-center gap-2">
              <button className="btn-primary" disabled={!walletRows.length}>
                Import and match
              </button>
            </div>
          </form>

          <div className="border-t border-line px-5 py-4">
            <form action={doMatch}>
              <button className="btn-secondary text-xs">Re-run the matcher</button>
            </form>
            <p className="mt-2 text-xxs text-ink-muted">
              Run this after adding a wallet address to a customer or vendor — previously unresolved
              transfers will find their counterparty.
            </p>
          </div>
        </Card>
      </div>

      <div className="mt-5">
        <Card
          title="Reconciliation queue"
          action={
            <span className="text-xxs text-ink-muted">
              Deterministic matcher — own wallets, then registered counterparties, then ledger history
            </span>
          }
        >
          {queue.length === 0 ? (
            <EmptyState title="Nothing waiting" hint="Every imported transfer has been dealt with." />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Wallet</th>
                  <th>Direction</th>
                  <th className="num">Amount</th>
                  <th className="num">Value</th>
                  <th>What the matcher found</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {queue.map((t) => (
                  <tr key={t.id}>
                    <td className="whitespace-nowrap text-ink-muted">{shortDate(t.occurredAt)}</td>
                    <td className="text-ink-muted">{t.walletLabel}</td>
                    <td>
                      <span className={t.direction === 'IN' ? 'badge-paid' : 'badge-neutral'}>
                        {t.direction === 'IN' ? 'in' : 'out'}
                      </span>
                    </td>
                    <td className="num whitespace-nowrap">
                      {formatUnits(t.assetAmountRaw, t.assetDecimals)} {t.assetSymbol}
                    </td>
                    <td className="num">{t.valueCents ? fmt(t.valueCents, cur) : '—'}</td>
                    <td className="max-w-md text-xs text-ink-muted">
                      {t.suggestionReason ?? 'Not examined yet.'}
                      {t.suggestedAccountName && (
                        <span className="ml-1 font-semibold text-ink">→ {t.suggestedAccountName}</span>
                      )}
                    </td>
                    <td>
                      <span className={statusClass(t.status)}>{t.status.replaceAll('_', ' ').toLowerCase()}</span>
                      {t.suggestionConfidence ? (
                        <span className="ml-1 text-xxs text-ink-light">{t.suggestionConfidence}%</span>
                      ) : null}
                    </td>
                    <td>
                      <Link href={`/onchain/${t.id}`} className="text-xs font-semibold text-brand-dark hover:underline">
                        Review →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {!mayPost && (
        <p className="mt-4 text-xs text-ink-muted">
          Your role can import and match, but not post. An accountant, admin or owner posts the entries.
        </p>
      )}
    </>
  );
}
