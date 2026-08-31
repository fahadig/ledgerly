/**
 * On-chain reconciliation.
 *
 * The thesis of this module in one line: **a transaction hash is a settlement
 * reference, exactly like a bank reference.** Everything else in the category
 * treats crypto as a separate sub-ledger that has to be synced into the real
 * books. Here it posts to the same general ledger, through the same posting
 * engine, checked by the same rules, and carries its proof on the entry.
 *
 * The matcher is deterministic — no model. It answers three questions in
 * order, and stops at the first one that resolves:
 *   1. Is the counterparty one of our own wallets?  → internal movement
 *   2. Is the counterparty a known customer or vendor? → their usual treatment
 *   3. Does anything in the ledger look like this?     → the history matcher
 * If none of them resolve, it says so rather than guessing.
 */

import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  accountingPolicies,
  accounts,
  assetPrices,
  companies,
  contacts,
  invoices,
  onchainTransactions,
  wallets,
  type OnchainTransaction,
  type Wallet,
} from '@/db/schema';
import { postJournal } from '../ledger';
import { checkEntry, type RuleFinding } from '../ai/rules';
import { suggestAccounts, type AccountSuggestion } from '../ai/patterns';
import type { Cents } from '../money';
import { formatUnits, valueInCents, type RawTransfer } from './provider';

const STABLECOINS = new Set(['USDC', 'USDT', 'DAI', 'PYUSD', 'USDP', 'TUSD', 'FDUSD', 'USDE']);

// ─────────────────────────── Valuation ───────────────────────────────

/**
 * Price of one whole unit, ×1,000,000, at a point in time.
 * A stablecoin defaults to parity, which is an assumption — so it is recorded
 * as one, with its source named, rather than hidden.
 */
export async function priceMicrosFor(
  symbol: string,
  at: Date,
  quoteCurrency = 'USD',
): Promise<{ priceMicros: number; source: string } | null> {
  const [row] = await db
    .select()
    .from(assetPrices)
    .where(
      and(
        eq(assetPrices.assetSymbol, symbol.toUpperCase()),
        eq(assetPrices.quoteCurrency, quoteCurrency),
        sql`${assetPrices.asOf} <= ${at}`,
      ),
    )
    .orderBy(desc(assetPrices.asOf))
    .limit(1);

  if (row) return { priceMicros: row.priceMicros, source: row.source };
  if (STABLECOINS.has(symbol.toUpperCase())) return { priceMicros: 1_000_000, source: 'assumed parity' };
  return null;
}

// ─────────────────────────── Import ──────────────────────────────────

export interface ImportResult {
  inserted: number;
  duplicates: number;
  unpriced: number;
  errors: string[];
}

/**
 * Land transfers against a wallet.
 *
 * Idempotent by `${chain}:${hash}:${logIndex}` — re-importing the same export
 * inserts nothing. "The same payment is never recorded twice, even when a feed
 * arrives more than once" is enforced here, at ingestion, rather than hoped
 * for downstream.
 */
export async function importTransfers(opts: {
  companyId: string;
  walletId: string;
  transfers: RawTransfer[];
}): Promise<ImportResult> {
  const result: ImportResult = { inserted: 0, duplicates: 0, unpriced: 0, errors: [] };
  if (!opts.transfers.length) return result;

  const [wallet] = await db
    .select()
    .from(wallets)
    .where(and(eq(wallets.id, opts.walletId), eq(wallets.companyId, opts.companyId)))
    .limit(1);
  if (!wallet) throw new Error('Wallet not found in this company.');

  const [company] = await db.select().from(companies).where(eq(companies.id, opts.companyId)).limit(1);
  const quote = company?.currency ?? 'USD';

  for (const t of opts.transfers) {
    const externalId = `${t.chainId}:${t.txHash}:${t.logIndex}`;

    let priceMicros = t.priceMicros ?? null;
    let priceSource = t.priceSource ?? null;
    if (priceMicros == null) {
      const looked = await priceMicrosFor(t.assetSymbol, t.occurredAt, quote);
      if (looked) {
        priceMicros = looked.priceMicros;
        priceSource = looked.source;
      }
    }

    if (priceMicros == null) result.unpriced++;

    const value = priceMicros == null ? 0 : valueInCents(t.amountRaw, t.assetDecimals, priceMicros);
    const feeValue =
      t.feeRaw && priceMicros != null && t.feeAssetSymbol === t.assetSymbol
        ? valueInCents(t.feeRaw, t.assetDecimals, priceMicros)
        : 0;

    const inserted = await db
      .insert(onchainTransactions)
      .values({
        companyId: opts.companyId,
        walletId: wallet.id,
        chainId: t.chainId,
        txHash: t.txHash,
        logIndex: t.logIndex,
        blockNumber: t.blockNumber ?? null,
        occurredAt: t.occurredAt,
        direction: t.direction,
        counterpartyAddress: t.counterpartyAddress ?? null,
        assetSymbol: t.assetSymbol,
        assetDecimals: t.assetDecimals,
        assetAmountRaw: t.amountRaw,
        valueCents: value,
        priceMicros,
        priceSource,
        feeRaw: t.feeRaw ?? null,
        feeAssetSymbol: t.feeAssetSymbol ?? null,
        feeCents: feeValue,
        memo: t.memo ?? null,
        status: 'UNMATCHED',
        externalId,
      })
      .onConflictDoNothing({ target: [onchainTransactions.companyId, onchainTransactions.externalId] })
      .returning({ id: onchainTransactions.id });

    if (inserted.length) result.inserted++;
    else result.duplicates++;
  }

  if (result.unpriced) {
    result.errors.push(
      `${result.unpriced} transfer(s) had no price and were valued at zero. Add a price in Settings → Asset prices, or include price_usd in the file, then re-run the matcher.`,
    );
  }

  return result;
}

// ─────────────────────────── Matching ────────────────────────────────

export interface OnchainMatch {
  kind: 'INTERNAL_TRANSFER' | 'KNOWN_COUNTERPARTY' | 'INVOICE_SETTLEMENT' | 'HISTORY' | 'UNRESOLVED';
  reason: string;
  confidence: number;
  contactId?: string | null;
  accountId?: string | null;
  invoiceId?: string | null;
  internalWalletId?: string | null;
  suggestions?: AccountSuggestion[];
}

/** Work out what a single transfer is, without a model. */
export async function matchTransaction(txn: OnchainTransaction): Promise<OnchainMatch> {
  const counterparty = (txn.counterpartyAddress ?? '').toLowerCase();

  // 1 · Our own wallet on the other side? Then no income or expense happened —
  //     value simply moved. Booking it as revenue would be double counting.
  if (counterparty) {
    const [ownWallet] = await db
      .select()
      .from(wallets)
      .innerJoin(companies, eq(companies.id, wallets.companyId))
      .where(
        and(
          eq(wallets.address, counterparty),
          eq(wallets.isActive, true),
          ne(wallets.id, txn.walletId),
        ),
      )
      .limit(1);

    if (ownWallet) {
      return {
        kind: 'INTERNAL_TRANSFER',
        reason: `The other side is ${ownWallet.wallets.label}, a wallet this group controls. This is a movement between our own accounts, not income or expense.`,
        confidence: 99,
        internalWalletId: ownWallet.wallets.id,
      };
    }
  }

  // 2 · A memo naming an open invoice is the strongest possible signal.
  if (txn.memo) {
    const refs = txn.memo.match(/\b(INV-\d+)\b/i);
    if (refs) {
      const [inv] = await db
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.companyId, txn.companyId),
            sql`upper(${invoices.number}) = ${refs[1].toUpperCase()}`,
            inArray(invoices.status, ['OPEN', 'PARTIAL', 'OVERDUE']),
          ),
        )
        .limit(1);

      if (inv) {
        const outstanding = inv.totalCents - inv.paidCents;
        const exact = Math.abs(outstanding - txn.valueCents) <= Math.max(100, Math.round(outstanding * 0.01));
        return {
          kind: 'INVOICE_SETTLEMENT',
          reason: `The memo names ${inv.number}, which is open with ${(outstanding / 100).toFixed(2)} outstanding${
            exact ? ' — and the amount matches within 1%.' : `, but this transfer is worth ${(txn.valueCents / 100).toFixed(2)}. Check before posting.`
          }`,
          confidence: exact ? 95 : 60,
          invoiceId: inv.id,
          contactId: inv.customerId,
        };
      }
    }
  }

  // 3 · A counterparty we already know by address.
  if (counterparty) {
    const [known] = await db
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.companyId, txn.companyId),
          eq(contacts.isActive, true),
          sql`${contacts.walletAddresses} @> ${JSON.stringify([counterparty])}::jsonb`,
        ),
      )
      .limit(1);

    if (known) {
      const suggestions = await suggestAccounts({
        companyId: txn.companyId,
        text: `${known.displayName} ${txn.memo ?? ''} ${txn.assetSymbol}`,
        contactId: known.id,
        direction: txn.direction === 'IN' ? 'MONEY_IN' : 'MONEY_OUT',
        amountCents: txn.valueCents,
        limit: 3,
      });

      return {
        kind: 'KNOWN_COUNTERPARTY',
        reason: `${counterparty.slice(0, 10)}… is a registered address for ${known.displayName}.${
          suggestions[0] ? ` They are usually booked to ${suggestions[0].name} — ${suggestions[0].reason}.` : ''
        }`,
        confidence: suggestions[0]?.confidence ?? 55,
        contactId: known.id,
        accountId: suggestions[0]?.accountId ?? null,
        suggestions,
      };
    }
  }

  // 4 · Fall back to what the ledger has done with similar descriptions.
  const suggestions = await suggestAccounts({
    companyId: txn.companyId,
    text: `${txn.memo ?? ''} ${txn.assetSymbol} ${counterparty}`,
    direction: txn.direction === 'IN' ? 'MONEY_IN' : 'MONEY_OUT',
    amountCents: txn.valueCents,
    limit: 3,
  });

  if (suggestions.length && suggestions[0].confidence >= 40) {
    return {
      kind: 'HISTORY',
      reason: `No registered counterparty. Closest match in the ledger: ${suggestions[0].name} — ${suggestions[0].reason}.`,
      confidence: suggestions[0].confidence,
      accountId: suggestions[0].accountId,
      suggestions,
    };
  }

  return {
    kind: 'UNRESOLVED',
    reason:
      'The counterparty address is not registered to anyone, and nothing comparable exists in the ledger. Categorise it by hand, or add the address to a customer or vendor and re-run the matcher.',
    confidence: 0,
    suggestions,
  };
}

/** Run the matcher over everything still unmatched, and record its opinion. */
export async function runMatcher(companyId: string): Promise<{ examined: number; resolved: number }> {
  const pending = await db
    .select()
    .from(onchainTransactions)
    .where(
      and(
        eq(onchainTransactions.companyId, companyId),
        inArray(onchainTransactions.status, ['UNMATCHED', 'SUGGESTED', 'INTERNAL_TRANSFER']),
      ),
    )
    .orderBy(asc(onchainTransactions.occurredAt));

  let resolved = 0;
  for (const txn of pending) {
    const match = await matchTransaction(txn);
    const status =
      match.kind === 'INTERNAL_TRANSFER' ? 'INTERNAL_TRANSFER' : match.kind === 'UNRESOLVED' ? 'UNMATCHED' : 'SUGGESTED';
    if (match.kind !== 'UNRESOLVED') resolved++;

    await db
      .update(onchainTransactions)
      .set({
        status,
        suggestedAccountId: match.accountId ?? null,
        suggestedContactId: match.contactId ?? null,
        suggestionConfidence: match.confidence,
        suggestionReason: match.reason,
        internalCounterpartWalletId: match.internalWalletId ?? null,
      })
      .where(eq(onchainTransactions.id, txn.id));
  }

  return { examined: pending.length, resolved };
}

// ─────────────────────── Proposed journal entry ──────────────────────

export interface ProposedOnchainLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  debitCents: Cents;
  creditCents: Cents;
  description: string;
  contactId?: string | null;
}

export interface OnchainProposal {
  txnId: string;
  match: OnchainMatch;
  lines: ProposedOnchainLine[];
  memo: string;
  balanced: boolean;
  findings: RuleFinding[];
  postable: boolean;
  /** The measurement basis this company reports digital assets under. */
  measurement: { policy: string; basis: string; citation: string } | null;
  warnings: string[];
}

/** The measurement rule for digital assets, which differs sharply by framework. */
export async function digitalAssetMeasurement(companyId: string) {
  const [company] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!company) return null;

  const [policy] = await db
    .select()
    .from(accountingPolicies)
    .where(and(eq(accountingPolicies.companyId, companyId), eq(accountingPolicies.key, 'crypto_classification')))
    .limit(1);

  const isIfrs = company.framework === 'IFRS';
  return {
    policy: policy?.value ?? (isIfrs ? 'INTANGIBLE_COST_MODEL' : 'FAIR_VALUE_THROUGH_INCOME'),
    basis: isIfrs
      ? 'Intangible asset at cost. Increases in value are NOT recognised in profit or loss; decreases are impairment losses.'
      : 'Fair value at each reporting date, with the change taken to net income, presented separately from other intangibles.',
    citation: isIfrs ? policy?.basis ?? 'IAS 38.8' : policy?.basis ?? 'ASC 350-60',
  };
}

async function accountByCode(companyId: string, code: string) {
  const [a] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.companyId, companyId), eq(accounts.code, code)))
    .limit(1);
  return a ?? null;
}

async function firstAccountMatching(companyId: string, like: string) {
  const [a] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.companyId, companyId), eq(accounts.isActive, true), sql`${accounts.name} ILIKE ${like}`))
    .orderBy(asc(accounts.code))
    .limit(1);
  return a ?? null;
}

/**
 * Turn a matched transfer into a reviewable entry.
 * Nothing here posts — it proposes, and the same rules engine that checks a
 * human's journal entry checks this one.
 */
export async function proposeOnchainEntry(txnId: string): Promise<OnchainProposal> {
  const [txn] = await db.select().from(onchainTransactions).where(eq(onchainTransactions.id, txnId)).limit(1);
  if (!txn) throw new Error('Transaction not found.');

  const [wallet] = await db.select().from(wallets).where(eq(wallets.id, txn.walletId)).limit(1);
  if (!wallet) throw new Error('Wallet not found.');

  const match = await matchTransaction(txn);
  const warnings: string[] = [];
  const lines: ProposedOnchainLine[] = [];

  const assetAccount =
    (wallet.accountId ? (await db.select().from(accounts).where(eq(accounts.id, wallet.accountId)).limit(1))[0] : null) ??
    (await firstAccountMatching(txn.companyId, '%digital asset%'));

  if (!assetAccount) {
    throw new Error('No digital-asset account is configured for this wallet or company.');
  }

  if (txn.valueCents <= 0) {
    warnings.push('This transfer has no fiat value, so it cannot be posted. Add a price for the asset and re-run the matcher.');
  }

  const amount = `${formatUnits(txn.assetAmountRaw, txn.assetDecimals)} ${txn.assetSymbol}`;
  const short = txn.txHash.length > 14 ? `${txn.txHash.slice(0, 10)}…${txn.txHash.slice(-6)}` : txn.txHash;
  const memo = `${txn.direction === 'IN' ? 'Received' : 'Sent'} ${amount} · ${txn.chainId} ${short}`;

  const push = (l: ProposedOnchainLine) => lines.push(l);
  const asLine = (a: { id: string; code: string; name: string }, side: 'DEBIT' | 'CREDIT', value: Cents, description: string, contactId?: string | null) =>
    push({
      accountId: a.id,
      accountCode: a.code,
      accountName: a.name,
      debitCents: side === 'DEBIT' ? value : 0,
      creditCents: side === 'CREDIT' ? value : 0,
      description,
      contactId: contactId ?? null,
    });

  if (match.kind === 'INTERNAL_TRANSFER' && match.internalWalletId) {
    const [other] = await db.select().from(wallets).where(eq(wallets.id, match.internalWalletId)).limit(1);
    const otherAccount = other?.accountId
      ? (await db.select().from(accounts).where(eq(accounts.id, other.accountId)).limit(1))[0]
      : null;

    if (other && other.companyId !== txn.companyId) {
      warnings.push(
        `The other wallet belongs to ${'another group company'}. Post this as an intercompany movement so consolidation eliminates it, rather than as a plain transfer.`,
      );
    }

    if (otherAccount && otherAccount.id !== assetAccount.id) {
      if (txn.direction === 'IN') {
        asLine(assetAccount, 'DEBIT', txn.valueCents, `Transfer in from ${other?.label ?? 'own wallet'}`);
        asLine(otherAccount, 'CREDIT', txn.valueCents, `Transfer out to ${wallet.label}`);
      } else {
        asLine(otherAccount, 'DEBIT', txn.valueCents, `Transfer in from ${wallet.label}`);
        asLine(assetAccount, 'CREDIT', txn.valueCents, `Transfer out to ${other?.label ?? 'own wallet'}`);
      }
    } else {
      warnings.push(
        'Both wallets post to the same account, so this movement nets to nothing in the ledger. Exclude it rather than posting a zero entry.',
      );
    }
  } else {
    // The counterparty side: A/R when it settles an invoice, otherwise the
    // suggested income or expense account.
    let counterAccount: { id: string; code: string; name: string } | null = null;
    let counterDescription = txn.memo ?? 'On-chain settlement';

    if (match.kind === 'INVOICE_SETTLEMENT') {
      counterAccount = await firstAccountMatching(txn.companyId, '%accounts receivable%');
      // The memo usually already says what it settles; do not double up on it.
      counterDescription = /settle/i.test(txn.memo ?? '') ? (txn.memo as string) : `Settles ${txn.memo ?? 'invoice'}`;
      if (!counterAccount) warnings.push('No accounts receivable account found.');
    } else if (match.accountId) {
      const [a] = await db.select().from(accounts).where(eq(accounts.id, match.accountId)).limit(1);
      counterAccount = a ?? null;
    }

    if (!counterAccount) {
      warnings.push('No account could be determined for the other side. Choose one before posting.');
    } else if (txn.direction === 'IN') {
      asLine(assetAccount, 'DEBIT', txn.valueCents, memo);
      asLine(counterAccount, 'CREDIT', txn.valueCents, counterDescription, match.contactId);
    } else {
      asLine(counterAccount, 'DEBIT', txn.valueCents, counterDescription, match.contactId);
      asLine(assetAccount, 'CREDIT', txn.valueCents, memo);
    }
  }

  // Network fees are their own expense, never netted off the transfer — the
  // same principle as a payment processor's fee.
  if (txn.feeCents > 0) {
    const feeAccount =
      (await firstAccountMatching(txn.companyId, '%network%fee%')) ??
      (await firstAccountMatching(txn.companyId, '%bank charge%'));
    if (feeAccount) {
      asLine(feeAccount, 'DEBIT', txn.feeCents, `Network fee · ${txn.chainId}`);
      asLine(assetAccount, 'CREDIT', txn.feeCents, `Gas paid from ${wallet.label}`);
    } else {
      warnings.push('A network fee was recorded but no fee account exists to book it to.');
    }
  }

  const totalDebit = lines.reduce((s, l) => s + l.debitCents, 0);
  const totalCredit = lines.reduce((s, l) => s + l.creditCents, 0);
  const balanced = lines.length >= 2 && totalDebit === totalCredit && totalDebit > 0;

  const check = lines.length
    ? await checkEntry({
        companyId: txn.companyId,
        date: txn.occurredAt,
        memo,
        lines: lines.map((l) => ({
          accountId: l.accountId,
          debitCents: l.debitCents,
          creditCents: l.creditCents,
          description: l.description,
          contactId: l.contactId ?? null,
        })),
      })
    : { findings: [], postable: false };

  return {
    txnId: txn.id,
    match,
    lines,
    memo,
    balanced,
    findings: check.findings,
    postable: balanced && check.postable && txn.valueCents > 0,
    measurement: await digitalAssetMeasurement(txn.companyId),
    warnings,
  };
}

// ─────────────────────────── Posting ─────────────────────────────────

/**
 * Post an approved proposal. The transaction hash travels with the entry, so
 * the chain reference is on the journal itself and an auditor can walk from a
 * reported figure back to a block.
 */
export async function postOnchainEntry(opts: {
  txnId: string;
  companyId: string;
  createdBy: string;
  lines: { accountId: string; debitCents: number; creditCents: number; description?: string; contactId?: string | null }[];
  memo?: string;
}) {
  const [txn] = await db
    .select()
    .from(onchainTransactions)
    .where(and(eq(onchainTransactions.id, opts.txnId), eq(onchainTransactions.companyId, opts.companyId)))
    .limit(1);
  if (!txn) throw new Error('Transaction not found.');
  if (txn.journalEntryId) throw new Error('This transfer has already been posted.');

  const check = await checkEntry({
    companyId: opts.companyId,
    date: txn.occurredAt,
    memo: opts.memo,
    lines: opts.lines,
  });
  if (!check.postable) {
    const blocking = check.findings.find((f) => f.severity === 'BLOCK');
    throw new Error(blocking?.message ?? 'This entry cannot be posted.');
  }

  const entry = await postJournal({
    companyId: opts.companyId,
    date: txn.occurredAt,
    memo: opts.memo ?? `On-chain settlement ${txn.txHash.slice(0, 10)}…`,
    source: txn.direction === 'IN' ? 'PAYMENT_RECEIVED' : 'PAYMENT_MADE',
    sourceId: txn.id,
    createdBy: opts.createdBy,
    settlementRail: 'ONCHAIN',
    settlementRef: {
      chainId: txn.chainId,
      txHash: txn.txHash,
      address: txn.counterpartyAddress ?? undefined,
      blockNumber: txn.blockNumber ?? undefined,
    },
    lines: opts.lines.map((l) => ({
      accountId: l.accountId,
      debit: l.debitCents,
      credit: l.creditCents,
      description: l.description ?? null,
      contactId: l.contactId ?? null,
    })),
  });

  await db
    .update(onchainTransactions)
    .set({ status: 'RECONCILED', journalEntryId: entry.id })
    .where(eq(onchainTransactions.id, txn.id));

  return entry;
}

export async function excludeTransaction(companyId: string, txnId: string, reason: string) {
  await db
    .update(onchainTransactions)
    .set({ status: 'EXCLUDED', suggestionReason: reason })
    .where(and(eq(onchainTransactions.id, txnId), eq(onchainTransactions.companyId, companyId)));
}

// ─────────────────────────── Queries ─────────────────────────────────

export async function listWallets(companyId: string): Promise<Wallet[]> {
  return db.select().from(wallets).where(eq(wallets.companyId, companyId)).orderBy(asc(wallets.label));
}

export interface QueueRow extends OnchainTransaction {
  walletLabel: string;
  suggestedAccountName: string | null;
  suggestedContactName: string | null;
  entryNo: string | null;
}

export async function reconciliationQueue(companyId: string, statuses?: string[]): Promise<QueueRow[]> {
  const wanted = statuses?.length ? statuses : ['UNMATCHED', 'SUGGESTED', 'INTERNAL_TRANSFER'];
  const result = await db.execute(sql`
    SELECT t.*, w.label AS wallet_label,
           a.name AS suggested_account_name,
           c.display_name AS suggested_contact_name,
           je.entry_no AS entry_no
    FROM onchain_transactions t
    JOIN wallets w ON w.id = t.wallet_id
    LEFT JOIN accounts a ON a.id = t.suggested_account_id
    LEFT JOIN contacts c ON c.id = t.suggested_contact_id
    LEFT JOIN journal_entries je ON je.id = t.journal_entry_id
    WHERE t.company_id = ${companyId}
      AND t.status::text = ANY(${sql.raw(`ARRAY[${wanted.map((s) => `'${s}'`).join(',')}]::text[]`)})
    ORDER BY t.occurred_at DESC
    LIMIT 300
  `);

  return (result.rows as unknown as Record<string, unknown>[]).map((r) => ({
    ...(r as unknown as OnchainTransaction),
    id: r.id as string,
    walletId: r.wallet_id as string,
    chainId: r.chain_id as string,
    txHash: r.tx_hash as string,
    logIndex: Number(r.log_index),
    blockNumber: r.block_number == null ? null : Number(r.block_number),
    occurredAt: new Date(r.occurred_at as string),
    counterpartyAddress: (r.counterparty_address as string) ?? null,
    assetSymbol: r.asset_symbol as string,
    assetDecimals: Number(r.asset_decimals),
    assetAmountRaw: r.asset_amount_raw as string,
    valueCents: Number(r.value_cents),
    feeCents: Number(r.fee_cents),
    suggestionConfidence: r.suggestion_confidence == null ? null : Number(r.suggestion_confidence),
    suggestionReason: (r.suggestion_reason as string) ?? null,
    status: r.status as OnchainTransaction['status'],
    walletLabel: r.wallet_label as string,
    suggestedAccountName: (r.suggested_account_name as string) ?? null,
    suggestedContactName: (r.suggested_contact_name as string) ?? null,
    entryNo: (r.entry_no as string) ?? null,
  })) as QueueRow[];
}

export interface OnchainSummary {
  wallets: number;
  unmatched: number;
  suggested: number;
  internal: number;
  reconciled: number;
  unmatchedValueCents: Cents;
}

export async function onchainSummary(companyId: string): Promise<OnchainSummary> {
  const result = await db.execute(sql`
    SELECT status::text AS status, COUNT(*)::int AS n, COALESCE(SUM(value_cents),0)::bigint AS value
    FROM onchain_transactions WHERE company_id = ${companyId} GROUP BY 1
  `);
  const rows = result.rows as unknown as { status: string; n: number; value: number | string }[];
  const get = (s: string) => rows.find((r) => r.status === s);

  const [{ count } = { count: 0 }] = (
    await db.execute(sql`SELECT COUNT(*)::int AS count FROM wallets WHERE company_id = ${companyId} AND is_active = true`)
  ).rows as unknown as { count: number }[];

  return {
    wallets: Number(count ?? 0),
    unmatched: get('UNMATCHED')?.n ?? 0,
    suggested: get('SUGGESTED')?.n ?? 0,
    internal: get('INTERNAL_TRANSFER')?.n ?? 0,
    reconciled: get('RECONCILED')?.n ?? 0,
    unmatchedValueCents: Number(get('UNMATCHED')?.value ?? 0),
  };
}
