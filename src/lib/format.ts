import { fmt, fmtAccounting, type Cents } from './money';

export { fmt, fmtAccounting };

export function shortDate(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
}

export function statusClass(status: string): string {
  switch (status) {
    case 'PAID':
      return 'badge-paid';
    case 'OVERDUE':
      return 'badge-overdue';
    case 'PARTIAL':
      return 'badge-partial';
    case 'OPEN':
      return 'badge-open';
    default:
      return 'badge-neutral';
  }
}

/** Signed presentation used on P&L variance columns. */
export function signed(cents: Cents, currency: string): string {
  return `${cents >= 0 ? '' : '−'}${fmt(Math.abs(cents), currency)}`;
}

export const frameworkLabel = (f: string) => (f === 'US_GAAP' ? 'US GAAP' : 'IFRS');
