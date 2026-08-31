import { getGroup } from '@/lib/company';
import { consolidate, type ConsolidationResult } from '@/lib/consolidation';
import { fmt, shortDate } from '@/lib/format';
import { Card, EmptyState, PageHeader, StatTile } from '@/components/ui';

export default async function ConsolidationPage() {
  const group = await getGroup();

  if (!group) {
    return (
      <>
        <PageHeader title="Consolidation" />
        <Card>
          <EmptyState
            title="This company is not part of a group"
            hint="Assign it to a group in Settings to produce consolidated statements."
          />
        </Card>
      </>
    );
  }

  let result: ConsolidationResult | undefined;
  let failure: string | null = null;
  try {
    result = await consolidate({ groupId: group.id, periodEnd: new Date() });
  } catch (err) {
    failure = (err as Error).message;
  }

  if (!result) {
    return (
      <>
        <PageHeader title="Consolidation" />
        <Card>
          <EmptyState title="Could not consolidate" hint={failure ?? undefined} />
        </Card>
      </>
    );
  }

  const cur = result.presentationCurrency;

  return (
    <>
      <PageHeader
        title={`${result.groupName} — consolidated`}
        subtitle={`${shortDate(result.periodStart)} to ${shortDate(result.periodEnd)} · presented in ${cur} · prepared under ${
          group.framework === 'US_GAAP' ? 'US GAAP' : 'IFRS'
        }`}
      />

      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Total assets" value={fmt(result.totals.assets, cur)} />
        <StatTile label="Total liabilities" value={fmt(result.totals.liabilities, cur)} />
        <StatTile label="Total equity" value={fmt(result.totals.equity, cur)} />
        <StatTile
          label="Consolidated profit"
          value={fmt(result.totals.profit, cur)}
          hint={`${fmt(result.totals.profitAttributableToParent, cur)} to owners · ${fmt(result.totals.profitAttributableToNCI, cur)} to NCI`}
          tone={result.totals.profit >= 0 ? 'good' : 'bad'}
        />
      </div>

      <div
        className={`mb-5 rounded border px-4 py-3 text-sm ${
          result.totals.outOfBalance === 0 ? 'border-brand bg-green-50 text-brand-dark' : 'border-red-400 bg-red-50 text-red-800'
        }`}
      >
        {result.totals.outOfBalance === 0
          ? `Consolidated statement of financial position balances. Translation reserve ${fmt(result.totals.translationReserve, cur)}.`
          : `Consolidated position is out by ${fmt(result.totals.outOfBalance, cur)}.`}
      </div>

      {result.warnings.length > 0 && (
        <Card title="Reconcile before finalising" className="mb-5">
          <div className="px-5 py-4">
            {result.warnings.map((w, i) => (
              <p key={i} className="mb-2 text-sm text-amber-800 last:mb-0">
                {w}
              </p>
            ))}
            <p className="mt-3 text-xs text-ink-muted">
              Intercompany differences are reported, never plugged. The only balancing figure this engine derives is the
              translation reserve, which is a genuine residual under IAS&nbsp;21.39 / ASC&nbsp;830-30.
            </p>
          </div>
        </Card>
      )}

      <Card title="Group members" className="mb-5">
        <table className="table">
          <thead>
            <tr>
              <th>Company</th>
              <th>Role</th>
              <th>Framework</th>
              <th>Functional currency</th>
              <th className="num">Ownership</th>
            </tr>
          </thead>
          <tbody>
            {result.companies.map((c) => (
              <tr key={c.id}>
                <td className="font-medium">{c.name}</td>
                <td className="text-ink-muted">{c.isParent ? 'Parent' : 'Subsidiary'}</td>
                <td className="text-ink-muted">{c.framework === 'US_GAAP' ? 'US GAAP' : 'IFRS'}</td>
                <td className="text-ink-muted">{c.currency}</td>
                <td className="num">{(c.ownershipBps / 100).toFixed(0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Eliminations — every one explained" className="mb-5">
        {result.eliminationEntries.length === 0 ? (
          <EmptyState title="Nothing to eliminate" hint="No intercompany traffic in this period." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Explanation</th>
                <th>Basis</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {result.eliminationEntries.map((e, i) => (
                <tr key={i}>
                  <td>
                    <span className="badge-neutral">{e.kind.replaceAll('_', ' ').toLowerCase()}</span>
                  </td>
                  <td>{e.explanation}</td>
                  <td className="text-xs text-ink-muted">{e.standardRef ?? '—'}</td>
                  <td className="num font-medium">{fmt(e.amountCents, cur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Consolidated trial balance">
        <table className="table">
          <thead>
            <tr>
              <th className="w-24">Code</th>
              <th>Account</th>
              {result.companies.map((c) => (
                <th key={c.id} className="num">
                  {c.name}
                </th>
              ))}
              <th className="num">Aggregate</th>
              <th className="num">Eliminated</th>
              <th className="num">Consolidated</th>
            </tr>
          </thead>
          <tbody>
            {result.lines.map((l) => (
              <tr key={`${l.groupAccountCode}-${l.type}`}>
                <td className="tabular text-ink-muted">{l.groupAccountCode}</td>
                <td>{l.name}</td>
                {result.companies.map((c) => (
                  <td key={c.id} className="num text-ink-muted">
                    {l.byCompany[c.id] ? fmt(l.byCompany[c.id], cur) : '—'}
                  </td>
                ))}
                <td className="num">{fmt(l.aggregate, cur)}</td>
                <td className="num text-amber-800">{l.eliminated ? `(${fmt(l.eliminated, cur)})` : '—'}</td>
                <td className="num font-semibold">{fmt(l.consolidated, cur)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
