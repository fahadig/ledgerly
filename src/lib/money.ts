/**
 * Money handling.
 *
 * Rule for the whole codebase: amounts live as integer *minor units* (cents).
 * They are `bigint` in the database layer and plain `number` above it — a JS
 * number represents every integer up to 2^53 exactly, i.e. ±$90 trillion in
 * cents, which is comfortably beyond any ledger this will hold. Floats are
 * never used for arithmetic, only for formatting at the very edge.
 */

export type Cents = number;

/** Prisma bigint → cents. */
export const toCents = (v: bigint | number | null | undefined): Cents =>
  v == null ? 0 : typeof v === 'bigint' ? Number(v) : Math.round(v);

/** cents → Prisma bigint. */
export const toBig = (v: Cents): bigint => BigInt(Math.round(v));

/** Parse user input ("1,250.50", "1250.5", "$1250") into cents. */
export function parseAmount(input: string | number | null | undefined): Cents {
  if (input == null || input === '') return 0;
  if (typeof input === 'number') return Math.round(input * 100);
  const cleaned = input.replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return 0;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** Quantities are stored in thousandths so 1.5 units → 1500. */
export const QTY_SCALE = 1000;
export const parseQty = (input: string | number): number => {
  const n = typeof input === 'number' ? input : Number(String(input).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * QTY_SCALE) : QTY_SCALE;
};
export const qtyToNumber = (q: number): number => q / QTY_SCALE;

/** qty (thousandths) × unit price (cents) → line amount (cents), banker-safe. */
export const lineAmount = (qtyThousandths: number, unitPriceCents: Cents): Cents =>
  Math.round((qtyThousandths * unitPriceCents) / QTY_SCALE);

/** basis points, 1700 = 17% */
export const applyBps = (amountCents: Cents, bps: number): Cents =>
  Math.round((amountCents * bps) / 10_000);

const FORMATTERS = new Map<string, Intl.NumberFormat>();
function formatter(currency: string, opts: Intl.NumberFormatOptions = {}) {
  const key = currency + JSON.stringify(opts);
  let f = FORMATTERS.get(key);
  if (!f) {
    f = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
      ...opts,
    });
    FORMATTERS.set(key, f);
  }
  return f;
}

export function fmt(cents: Cents, currency = 'USD'): string {
  return formatter(currency).format(cents / 100);
}

/** Accounting presentation: negatives in parentheses, zero as a dash. */
export function fmtAccounting(cents: Cents, currency = 'USD'): string {
  if (cents === 0) return '—';
  const s = formatter(currency).format(Math.abs(cents) / 100);
  return cents < 0 ? `(${s})` : s;
}

export function fmtPlain(cents: Cents): string {
  return (cents / 100).toFixed(2);
}
