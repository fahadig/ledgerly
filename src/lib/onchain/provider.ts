/**
 * Where on-chain movements come from.
 *
 * Same shape as the AI provider: an interface with swappable implementations,
 * so adding a chain or an indexer is configuration rather than a rewrite. The
 * CSV provider always works and needs no network, which matters — a finance
 * team must be able to close the books when an indexer is down.
 *
 * Amounts are carried as decimal STRINGS in the asset's base units. A 256-bit
 * token amount does not fit in any numeric type we would want to do accounting
 * arithmetic in, and silently losing the last few digits of a transfer is not
 * a rounding difference — it is a wrong balance.
 */

export interface RawTransfer {
  chainId: string;
  txHash: string;
  logIndex: number;
  blockNumber?: number | null;
  occurredAt: Date;
  /** Relative to the wallet being imported. */
  direction: 'IN' | 'OUT';
  walletAddress: string;
  counterpartyAddress?: string | null;
  assetSymbol: string;
  assetDecimals: number;
  /** Base units, decimal string. 1.5 USDC (6 dp) is "1500000". */
  amountRaw: string;
  feeRaw?: string | null;
  feeAssetSymbol?: string | null;
  /** Price of one whole unit in the quote currency, if the source knows it. */
  priceMicros?: number | null;
  priceSource?: string | null;
  memo?: string | null;
}

export interface ChainProvider {
  name: string;
  available(): Promise<boolean>;
  fetchTransfers(opts: { chainId: string; address: string; since?: Date }): Promise<RawTransfer[]>;
}

// ─────────────────────── Base-unit arithmetic ────────────────────────

/** Base units → a human decimal string, exactly. No floating point. */
export function formatUnits(amountRaw: string, decimals: number): string {
  const negative = amountRaw.startsWith('-');
  const digits = (negative ? amountRaw.slice(1) : amountRaw).replace(/\D/g, '') || '0';
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals) || '0';
  const frac = decimals > 0 ? padded.slice(padded.length - decimals).replace(/0+$/, '') : '';
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** A human decimal string → base units, exactly. */
export function parseUnits(amount: string, decimals: number): string {
  const [whole = '0', frac = ''] = amount.trim().replace(/,/g, '').split('.');
  const paddedFrac = frac.padEnd(decimals, '0').slice(0, decimals);
  return `${BigInt(whole + paddedFrac)}`;
}

/**
 * Fiat value of a transfer, in minor units.
 * Done in BigInt end to end so a large transfer of an 18-decimal token cannot
 * lose precision on its way to the ledger.
 */
export function valueInCents(amountRaw: string, decimals: number, priceMicros: number): number {
  const amount = BigInt(amountRaw || '0');
  const price = BigInt(Math.round(priceMicros));
  // amount / 10^decimals × price / 1e6 × 100 minor units
  const numerator = amount * price * 100n;
  const denominator = 10n ** BigInt(decimals) * 1_000_000n;
  if (denominator === 0n) return 0;
  // Round half up rather than truncating, so many small transfers do not drift.
  const doubled = (numerator * 2n) / denominator;
  const rounded = doubled / 2n + (doubled % 2n === 0n ? 0n : 1n);
  return Number(rounded);
}

// ─────────────────────────── CSV provider ────────────────────────────

const CSV_COLUMNS = [
  'chain',
  'tx_hash',
  'log_index',
  'block_number',
  'timestamp',
  'direction',
  'wallet_address',
  'counterparty_address',
  'asset_symbol',
  'asset_decimals',
  'amount_raw',
  'fee_raw',
  'fee_asset',
  'price_usd',
  'memo',
] as const;

export const CSV_TEMPLATE = `${CSV_COLUMNS.join(',')}\n` +
  'ethereum,0xabc…,0,19000000,2026-08-01T10:00:00Z,IN,0xOurWallet,0xCustomer,USDC,6,2500000000,,,1.0,Invoice INV-0042\n';

/** Split one CSV line, honouring double quotes. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

export interface CsvParseResult {
  transfers: RawTransfer[];
  errors: string[];
}

/**
 * Parse an exported transfer file. Rejects rows rather than guessing at them —
 * a row we cannot read is reported, never silently dropped, because a missing
 * transfer is an unexplained balance later.
 */
export function parseTransferCsv(text: string): CsvParseResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  const errors: string[] = [];
  if (!lines.length) return { transfers: [], errors: ['The file is empty.'] };

  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const missing = ['chain', 'tx_hash', 'timestamp', 'direction', 'wallet_address', 'asset_symbol', 'amount_raw'].filter(
    (c) => !header.includes(c),
  );
  if (missing.length) {
    return { transfers: [], errors: [`Missing required column(s): ${missing.join(', ')}.`] };
  }

  const col = (row: string[], name: string): string => {
    const i = header.indexOf(name);
    return i === -1 ? '' : row[i] ?? '';
  };

  const transfers: RawTransfer[] = [];
  for (let n = 1; n < lines.length; n++) {
    const row = splitCsvLine(lines[n]);
    const rowNo = n + 1;

    const direction = col(row, 'direction').toUpperCase();
    if (direction !== 'IN' && direction !== 'OUT') {
      errors.push(`Row ${rowNo}: direction must be IN or OUT, got "${col(row, 'direction')}".`);
      continue;
    }

    const occurredAt = new Date(col(row, 'timestamp'));
    if (Number.isNaN(occurredAt.getTime())) {
      errors.push(`Row ${rowNo}: could not read the timestamp "${col(row, 'timestamp')}".`);
      continue;
    }

    const amountRaw = col(row, 'amount_raw').replace(/[, ]/g, '');
    if (!/^\d+$/.test(amountRaw)) {
      errors.push(`Row ${rowNo}: amount_raw must be whole base units, got "${col(row, 'amount_raw')}".`);
      continue;
    }

    const decimals = Number(col(row, 'asset_decimals') || 18);
    const price = col(row, 'price_usd');

    transfers.push({
      chainId: col(row, 'chain').toLowerCase(),
      txHash: col(row, 'tx_hash'),
      logIndex: Number(col(row, 'log_index') || 0),
      blockNumber: col(row, 'block_number') ? Number(col(row, 'block_number')) : null,
      occurredAt,
      direction,
      walletAddress: col(row, 'wallet_address').toLowerCase(),
      counterpartyAddress: col(row, 'counterparty_address')?.toLowerCase() || null,
      assetSymbol: col(row, 'asset_symbol').toUpperCase(),
      assetDecimals: Number.isFinite(decimals) ? decimals : 18,
      amountRaw,
      feeRaw: col(row, 'fee_raw')?.replace(/[, ]/g, '') || null,
      feeAssetSymbol: col(row, 'fee_asset')?.toUpperCase() || null,
      priceMicros: price ? Math.round(Number(price) * 1_000_000) : null,
      priceSource: price ? 'file' : null,
      memo: col(row, 'memo') || null,
    });
  }

  return { transfers, errors };
}

// ─────────────────── Explorer provider (EVM-compatible) ──────────────

/**
 * Etherscan-compatible indexer. Configure with ONCHAIN_EXPLORER_URL and
 * ONCHAIN_EXPLORER_KEY. Written to the same interface as the CSV provider, so
 * whichever is available produces identical rows downstream.
 */
export class ExplorerProvider implements ChainProvider {
  name = 'explorer';
  private base = (process.env.ONCHAIN_EXPLORER_URL || '').replace(/\/$/, '');
  private key = process.env.ONCHAIN_EXPLORER_KEY || '';

  async available() {
    return Boolean(this.base && this.key);
  }

  async fetchTransfers(opts: { chainId: string; address: string; since?: Date }): Promise<RawTransfer[]> {
    if (!(await this.available())) {
      throw new Error('No block explorer configured. Set ONCHAIN_EXPLORER_URL and ONCHAIN_EXPLORER_KEY, or import a file.');
    }

    const url = new URL(this.base);
    url.searchParams.set('module', 'account');
    url.searchParams.set('action', 'tokentx');
    url.searchParams.set('address', opts.address);
    url.searchParams.set('sort', 'asc');
    url.searchParams.set('apikey', this.key);

    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Explorer returned ${res.status}.`);
    const body = (await res.json()) as { status?: string; message?: string; result?: unknown };

    if (body.status !== '1' || !Array.isArray(body.result)) {
      // "No transactions found" is a valid empty answer, not a failure.
      if (/no transactions found/i.test(String(body.message))) return [];
      throw new Error(`Explorer error: ${body.message ?? 'unknown'}.`);
    }

    const mine = opts.address.toLowerCase();
    return (body.result as Record<string, string>[])
      .map((r, i) => {
        const from = (r.from ?? '').toLowerCase();
        const direction: 'IN' | 'OUT' = from === mine ? 'OUT' : 'IN';
        return {
          chainId: opts.chainId,
          txHash: r.hash,
          logIndex: Number(r.logIndex ?? i),
          blockNumber: Number(r.blockNumber ?? 0),
          occurredAt: new Date(Number(r.timeStamp ?? 0) * 1000),
          direction,
          walletAddress: mine,
          counterpartyAddress: direction === 'OUT' ? (r.to ?? '').toLowerCase() : from,
          assetSymbol: (r.tokenSymbol ?? 'ETH').toUpperCase(),
          assetDecimals: Number(r.tokenDecimal ?? 18),
          amountRaw: r.value ?? '0',
          feeRaw: r.gasUsed && r.gasPrice ? `${BigInt(r.gasUsed) * BigInt(r.gasPrice)}` : null,
          feeAssetSymbol: r.gasUsed ? 'ETH' : null,
          priceMicros: null,
          priceSource: null,
          memo: null,
        } satisfies RawTransfer;
      })
      .filter((t) => !opts.since || t.occurredAt >= opts.since!);
  }
}

export function getChainProvider(): ChainProvider {
  return new ExplorerProvider();
}
