'use client';

import { useEffect, useMemo, useState } from 'react';

interface AccountOption {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
}

interface Line {
  accountId: string;
  description: string;
  debitCents: number;
  creditCents: number;
  contactId: string | null;
}

interface Finding {
  rule: string;
  severity: 'BLOCK' | 'WARN' | 'INFO';
  message: string;
  lineIndex?: number;
  standardRef?: string;
}

const blankLine = (): Line => ({ accountId: '', description: '', debitCents: 0, creditCents: 0, contactId: null });

function fmtCents(cents: number, currency: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2 }).format(cents / 100);
}

export default function JournalEditor({
  accounts,
  contacts,
  currency,
}: {
  accounts: AccountOption[];
  contacts: { id: string; displayName: string }[];
  currency: string;
}) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<Line[]>([blankLine(), blankLine()]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [checking, setChecking] = useState(false);
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const totals = useMemo(() => {
    const debit = lines.reduce((s, l) => s + (l.debitCents || 0), 0);
    const credit = lines.reduce((s, l) => s + (l.creditCents || 0), 0);
    return { debit, credit, balanced: debit === credit && debit > 0 };
  }, [lines]);

  const ready = lines.filter((l) => l.accountId && (l.debitCents || l.creditCents));

  // Checks run as you type, so the ledger's opinion is never a surprise at the end.
  useEffect(() => {
    if (ready.length < 2) {
      setFindings([]);
      return;
    }
    const t = setTimeout(async () => {
      setChecking(true);
      try {
        const res = await fetch('/api/entries/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date, memo, lines: ready }),
        });
        const json = await res.json();
        setFindings(json.ok ? json.findings : []);
      } finally {
        setChecking(false);
      }
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(ready), date, memo]);

  const blocking = findings.filter((f) => f.severity === 'BLOCK');
  const canPost = totals.balanced && ready.length >= 2 && blocking.length === 0 && !posting;

  const update = (i: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  async function post() {
    setPosting(true);
    setError(null);
    try {
      const res = await fetch('/api/assistant/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, memo, aiAssisted: false, lines: ready }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? 'Could not post.');
      setPosted(json.entryNo);
      setLines([blankLine(), blankLine()]);
      setMemo('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="space-y-4">
      {posted && (
        <div className="rounded border border-brand bg-green-50 px-4 py-3 text-sm text-brand-dark">
          Posted as <strong>{posted}</strong>.
        </div>
      )}
      {error && <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}

      <section className="card p-5">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <label className="label" htmlFor="je-date">
              Date
            </label>
            <input id="je-date" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="md:col-span-2">
            <label className="label" htmlFor="je-memo">
              Memo
            </label>
            <input
              id="je-memo"
              className="input"
              placeholder="What is this entry for?"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
            />
          </div>
        </div>
      </section>

      <section className="card">
        <table className="table">
          <thead>
            <tr>
              <th className="w-[28%]">Account</th>
              <th>Description</th>
              <th className="w-[16%]">Name</th>
              <th className="w-32 num">Debit</th>
              <th className="w-32 num">Credit</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const lineFindings = findings.filter((f) => f.lineIndex === i);
              return (
                <tr key={i} className={lineFindings.some((f) => f.severity === 'BLOCK') ? 'bg-red-50' : ''}>
                  <td>
                    <select className="input py-1.5" value={l.accountId} onChange={(e) => update(i, { accountId: e.target.value })}>
                      <option value="">Select an account…</option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.code} · {a.name}
                        </option>
                      ))}
                    </select>
                    {lineFindings.map((f, k) => (
                      <p key={k} className={`mt-1 text-xxs ${f.severity === 'BLOCK' ? 'text-red-700' : 'text-amber-700'}`}>
                        {f.message}
                      </p>
                    ))}
                  </td>
                  <td>
                    <input className="input py-1.5" value={l.description} onChange={(e) => update(i, { description: e.target.value })} />
                  </td>
                  <td>
                    <select
                      className="input py-1.5"
                      value={l.contactId ?? ''}
                      onChange={(e) => update(i, { contactId: e.target.value || null })}
                    >
                      <option value="">—</option>
                      {contacts.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.displayName}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      className="input py-1.5 text-right tabular"
                      inputMode="decimal"
                      value={l.debitCents ? (l.debitCents / 100).toFixed(2) : ''}
                      onChange={(e) =>
                        update(i, {
                          debitCents: Math.round(Number(e.target.value.replace(/[^0-9.]/g, '') || 0) * 100),
                          creditCents: 0,
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      className="input py-1.5 text-right tabular"
                      inputMode="decimal"
                      value={l.creditCents ? (l.creditCents / 100).toFixed(2) : ''}
                      onChange={(e) =>
                        update(i, {
                          creditCents: Math.round(Number(e.target.value.replace(/[^0-9.]/g, '') || 0) * 100),
                          debitCents: 0,
                        })
                      }
                    />
                  </td>
                  <td>
                    {lines.length > 2 && (
                      <button
                        className="text-ink-light hover:text-red-600"
                        onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
                        aria-label="Remove line"
                      >
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            <tr className="bg-surface font-semibold">
              <td colSpan={3} className="text-right text-xs uppercase tracking-wide text-ink-muted">
                Totals
              </td>
              <td className="num">{fmtCents(totals.debit, currency)}</td>
              <td className="num">{fmtCents(totals.credit, currency)}</td>
              <td />
            </tr>
          </tbody>
        </table>

        {findings.filter((f) => f.lineIndex === undefined).length > 0 && (
          <div className="border-t border-line px-5 py-4">
            {findings
              .filter((f) => f.lineIndex === undefined)
              .map((f, i) => (
                <p
                  key={i}
                  className={`mb-1.5 text-sm last:mb-0 ${
                    f.severity === 'BLOCK' ? 'text-red-700' : f.severity === 'WARN' ? 'text-amber-800' : 'text-ink-muted'
                  }`}
                >
                  <span className="mr-2 font-semibold">{f.severity}</span>
                  {f.message}
                  {f.standardRef && <span className="ml-2 text-xxs text-ink-muted">({f.standardRef})</span>}
                </p>
              ))}
          </div>
        )}

        <div className="flex items-center gap-3 border-t border-line px-5 py-4">
          <button className="btn-secondary" onClick={() => setLines((prev) => [...prev, blankLine()])}>
            Add line
          </button>
          <span className="text-xxs text-ink-muted">
            {checking ? 'Checking…' : totals.balanced ? 'Balanced' : 'Debits must equal credits'}
          </span>
          <button className="btn-primary ml-auto" onClick={post} disabled={!canPost}>
            {posting ? 'Posting…' : 'Post entry'}
          </button>
        </div>
      </section>
    </div>
  );
}
