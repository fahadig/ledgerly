'use client';

import { useMemo, useState } from 'react';

interface AccountOption {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
}

interface DraftLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  debitCents: number;
  creditCents: number;
  description: string;
  standardRef?: string | null;
}

interface Finding {
  rule: string;
  severity: 'BLOCK' | 'WARN' | 'INFO';
  message: string;
  lineIndex?: number;
  standardRef?: string;
}

interface Standard {
  reference: string;
  topic: string;
  title: string;
  requirement: string;
  treatment: string;
  divergenceNote: string | null;
  disclosure: string | null;
  policyKey: string | null;
  policyValue?: string | null;
  relevance: number;
}

interface Suggestion {
  accountId: string;
  code: string;
  name: string;
  confidence: number;
  reason: string;
  timesUsed: number;
  lastUsed: string | null;
  evidence: { date: string; description: string; amountCents: number; contactName?: string | null }[];
}

interface Draft {
  date: string;
  memo: string;
  lines: DraftLine[];
  balanced: boolean;
  confidence: number;
  policy: { mode: 'READY' | 'REVIEW' | 'MANUAL'; headline: string; detail: string; requiresAcknowledgement: boolean };
  rationale: string;
  standards: Standard[];
  divergence: { framework: string; reference: string; title: string; treatment: string; divergenceNote: string | null } | null;
  conflicts: string[];
  warnings: string[];
  findings: Finding[];
  suggestions: Suggestion[];
  framework: string;
  provider: string;
  model: string;
  latencyMs: number;
  logId?: string;
}

const EXAMPLES = [
  'Paid Skyline Properties 1,800 for the September office rent from the operating bank account',
  'Received 4,500 from Cedar Analytics settling invoice INV-0012',
  'Bought a 2,400 laptop for the new engineer on the company credit card',
  'Capitalised 12,000 of development costs on the new platform module',
  'Wrote off 900 owed by Northwind Trading as a bad debt',
];

function fmtCents(cents: number, currency: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2 }).format(cents / 100);
}

export default function AssistantWorkbench({
  accounts,
  currency,
  framework,
}: {
  accounts: AccountOption[];
  currency: string;
  framework: string;
}) {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [posted, setPosted] = useState<{ entryNo: string } | null>(null);
  const [edited, setEdited] = useState(false);

  const totals = useMemo(() => {
    const debit = lines.reduce((s, l) => s + (l.debitCents || 0), 0);
    const credit = lines.reduce((s, l) => s + (l.creditCents || 0), 0);
    return { debit, credit, balanced: debit === credit && debit > 0 };
  }, [lines]);

  const blocking = (draft?.findings ?? []).filter((f) => f.severity === 'BLOCK');
  const canPost =
    totals.balanced &&
    lines.length >= 2 &&
    blocking.length === 0 &&
    (!draft?.policy.requiresAcknowledgement || acknowledged) &&
    !posted;

  async function requestDraft(input?: string) {
    const value = input ?? text;
    if (value.trim().length < 3) return;
    setLoading(true);
    setError(null);
    setPosted(null);
    setAcknowledged(false);
    setEdited(false);
    try {
      const res = await fetch('/api/assistant/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: value }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? 'The assistant could not draft this.');
      setDraft(json.draft);
      setLines(json.draft.lines);
    } catch (e) {
      setError((e as Error).message);
      setDraft(null);
      setLines([]);
    } finally {
      setLoading(false);
    }
  }

  async function post() {
    if (!draft) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/assistant/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: draft.date,
          memo: draft.memo,
          aiAssisted: true,
          logId: draft.logId,
          correctedByHuman: edited,
          standardRefs: draft.standards.map((s) => s.reference),
          lines: lines.map((l) => ({
            accountId: l.accountId,
            debitCents: l.debitCents,
            creditCents: l.creditCents,
            description: l.description,
          })),
        }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? 'Could not post the entry.');
      setPosted({ entryNo: json.entryNo });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const updateLine = (i: number, patch: Partial<DraftLine>) => {
    setEdited(true);
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  };

  const policyTone = {
    READY: 'border-brand bg-green-50',
    REVIEW: 'border-amber-400 bg-amber-50',
    MANUAL: 'border-ink-light bg-surface',
  };

  return (
    <div className="space-y-5">
      {/* ── Ask ────────────────────────────────────────────────── */}
      <section className="card p-5">
        <label className="label" htmlFor="assistant-input">
          Describe the transaction in plain English
        </label>
        <textarea
          id="assistant-input"
          className="input min-h-[84px] resize-y"
          placeholder="e.g. Paid Skyline Properties 1,800 for September office rent from the operating account"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') requestDraft();
          }}
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button className="btn-primary" onClick={() => requestDraft()} disabled={loading || text.trim().length < 3}>
            {loading ? 'Thinking…' : 'Draft the entry'}
          </button>
          <span className="text-xxs text-ink-muted">⌘/Ctrl + Enter</span>
          <span className="ml-auto text-xxs text-ink-muted">
            Reasoning under <strong>{framework === 'US_GAAP' ? 'US GAAP' : 'IFRS'}</strong>
          </span>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              onClick={() => {
                setText(ex);
                requestDraft(ex);
              }}
              className="rounded-full border border-line px-3 py-1 text-xxs text-ink-muted transition-colors hover:border-brand hover:text-brand-dark"
            >
              {ex.length > 54 ? `${ex.slice(0, 54)}…` : ex}
            </button>
          ))}
        </div>
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      )}

      {posted && (
        <div className="rounded border border-brand bg-green-50 px-4 py-3 text-sm text-brand-dark">
          Posted as <strong>{posted.entryNo}</strong>. It is now in the journal and the reports.
        </div>
      )}

      {draft && (
        <>
          {/* ── How much the assistant is allowed to do ───────────── */}
          <section className={`card border-l-4 p-5 ${policyTone[draft.policy.mode]}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h3 className="text-base font-semibold">{draft.policy.headline}</h3>
              <span className="text-xxs text-ink-muted">
                confidence {draft.confidence}% ·{' '}
                {draft.latencyMs
                  ? `${draft.provider}/${draft.model} · ${(draft.latencyMs / 1000).toFixed(1)}s`
                  : 'rule-set and history only, no model used'}
              </span>
            </div>
            <p className="mt-1 text-sm text-ink-muted">{draft.policy.detail}</p>
            <p className="mt-3 text-sm">{draft.rationale}</p>
          </section>

          {/* ── The basis ─────────────────────────────────────────── */}
          {draft.standards.length > 0 && (
            <section className="card">
              <div className="card-head">
                <h3 className="card-title">Basis for the treatment</h3>
                <span className="text-xxs text-ink-muted">Curated rule-set — verify against your accounting policy</span>
              </div>
              <div className="divide-y divide-line">
                {draft.standards.map((s) => (
                  <div key={s.reference} className="px-5 py-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="badge bg-slate-800 text-white">{s.reference}</span>
                      <span className="font-semibold">{s.title}</span>
                      <span className="ml-auto text-xxs text-ink-muted">{s.relevance}% match</span>
                    </div>
                    <p className="mt-2 text-sm text-ink-muted">{s.requirement}</p>
                    <p className="mt-1.5 text-sm">{s.treatment}</p>
                    {s.policyValue && (
                      <p className="mt-2 text-xs text-ink-muted">
                        Your policy: <strong>{s.policyKey}</strong> = {s.policyValue}
                      </p>
                    )}
                    {s.disclosure && (
                      <p className="mt-2 text-xs text-ink-muted">Triggers disclosure: {s.disclosure}</p>
                    )}
                  </div>
                ))}
              </div>

              {draft.divergence && (
                <div className="border-t border-line bg-surface px-5 py-4">
                  <div className="flex items-center gap-2">
                    <span className="badge bg-white text-ink">
                      Under {draft.divergence.framework === 'US_GAAP' ? 'US GAAP' : 'IFRS'}
                    </span>
                    <span className="text-sm font-semibold">{draft.divergence.reference}</span>
                  </div>
                  <p className="mt-1.5 text-sm text-ink-muted">{draft.divergence.treatment}</p>
                  {draft.divergence.divergenceNote && (
                    <p className="mt-1.5 text-sm text-amber-800">{draft.divergence.divergenceNote}</p>
                  )}
                </div>
              )}
            </section>
          )}

          {draft.conflicts.length > 0 && (
            <section className="card border-l-4 border-amber-500 bg-amber-50 p-5">
              <h3 className="text-base font-semibold text-amber-900">Past practice disagrees with the standard</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900">
                {draft.conflicts.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-amber-800">
                The assistant will not choose between them. Whichever you post is recorded with its basis.
              </p>
            </section>
          )}

          {/* ── The draft ─────────────────────────────────────────── */}
          <section className="card">
            <div className="card-head">
              <h3 className="card-title">Draft entry — {draft.date}</h3>
              <span className={`tabular text-sm font-semibold ${totals.balanced ? 'text-brand-dark' : 'text-red-700'}`}>
                {fmtCents(totals.debit, currency)} Dr / {fmtCents(totals.credit, currency)} Cr
                {!totals.balanced && ' — out of balance'}
              </span>
            </div>

            {lines.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-ink-muted">
                The assistant did not have enough to draft an entry. Add the missing detail and ask again.
              </div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th className="w-[30%]">Account</th>
                    <th>Description</th>
                    <th className="w-32 num">Debit</th>
                    <th className="w-32 num">Credit</th>
                    <th className="w-28">Basis</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => {
                    const lineFindings = (draft.findings ?? []).filter((f) => f.lineIndex === i);
                    return (
                      <tr key={i} className={lineFindings.some((f) => f.severity === 'BLOCK') ? 'bg-red-50' : ''}>
                        <td>
                          <select
                            className="input py-1.5"
                            value={l.accountId}
                            onChange={(e) => {
                              const acc = accounts.find((a) => a.id === e.target.value)!;
                              updateLine(i, { accountId: acc.id, accountCode: acc.code, accountName: acc.name });
                            }}
                          >
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
                          <input
                            className="input py-1.5"
                            value={l.description}
                            onChange={(e) => updateLine(i, { description: e.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            className="input py-1.5 text-right tabular"
                            inputMode="decimal"
                            value={l.debitCents ? (l.debitCents / 100).toFixed(2) : ''}
                            onChange={(e) =>
                              updateLine(i, {
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
                              updateLine(i, {
                                creditCents: Math.round(Number(e.target.value.replace(/[^0-9.]/g, '') || 0) * 100),
                                debitCents: 0,
                              })
                            }
                          />
                        </td>
                        <td className="text-xxs text-ink-muted">{l.standardRef ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {/* Findings that are not tied to one line */}
            {(draft.findings ?? []).filter((f) => f.lineIndex === undefined).length > 0 && (
              <div className="border-t border-line px-5 py-4">
                {draft.findings
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

            {draft.warnings.length > 0 && (
              <div className="border-t border-line bg-surface px-5 py-4">
                {draft.warnings.map((w, i) => (
                  <p key={i} className="mb-1 text-sm text-ink-muted last:mb-0">
                    {w}
                  </p>
                ))}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-4 border-t border-line px-5 py-4">
              {draft.policy.requiresAcknowledgement && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
                  I have checked the accounts and the basis, and I am posting this on my own judgement.
                </label>
              )}
              <button className="btn-primary ml-auto" onClick={post} disabled={!canPost || loading}>
                {posted ? 'Posted' : loading ? 'Posting…' : 'Post entry'}
              </button>
            </div>
          </section>

          {/* ── The evidence ──────────────────────────────────────── */}
          {draft.suggestions.length > 0 && (
            <section className="card">
              <div className="card-head">
                <h3 className="card-title">What the ledger has done before</h3>
                <span className="text-xxs text-ink-muted">Deterministic — no model involved</span>
              </div>
              <div className="divide-y divide-line">
                {draft.suggestions.map((s) => (
                  <div key={s.accountId} className="px-5 py-3">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="font-semibold">
                        <span className="tabular text-ink-muted">{s.code}</span> {s.name}
                      </span>
                      <span className="badge-neutral">{s.confidence}%</span>
                      <span className="text-xxs text-ink-muted">
                        used {s.timesUsed}× · last {s.lastUsed ?? 'n/a'}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-ink-muted">{s.reason}</p>
                    {s.evidence.length > 0 && (
                      <ul className="mt-2 space-y-0.5">
                        {s.evidence.map((e, i) => (
                          <li key={i} className="text-xxs text-ink-light">
                            {e.date} · {e.description} · {fmtCents(e.amountCents, currency)}
                            {e.contactName ? ` · ${e.contactName}` : ''}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
