import type { Operation } from '../types';

/**
 * PDF statement adapter — schema-only.
 *
 * PDFs are not parsed in this module: the PWA extracts a structured
 * `StatementDocument` (via Claude vision or any other layer) and feeds it
 * here. The mapping `StatementDocument → Operation[]` is pure TypeScript and
 * stays bank-agnostic: any source that conforms to this shape works.
 */

export interface StatementRow {
  date: string; // DD.MM.YYYY
  debit: number | null; // outflow as positive; null when inflow row
  credit: number | null; // inflow as positive; null when outflow row
  /** Purpose of payment as printed on the statement. */
  purpose: string;
  /** Optional human-friendly operation type, e.g. "Purchase", "Conversion". */
  operationType: string | null;
  /** Optional merchant name (when present, used as description). */
  merchant: string | null;
  /** Optional merchant city / country to disambiguate same-name merchants. */
  merchantCity: string | null;
  merchantCountry: string | null;
}

export interface StatementDocument {
  /** Account identifier (IBAN, account number, last digits). */
  account: string;
  currency: string;
  rows: StatementRow[];
}

/**
 * Derives `bankCategory` for a statement row. PDF statements rarely include
 * a built-in category, so it's synthesized from operation type:
 *
 *  - 'Conversion'  — FX between own multi-currency accounts.
 *  - 'Deposit'     — deposit accept/payout / transfer of own funds.
 *  - 'Purchase'    — card purchase at a merchant.
 *  - ''            — anything else; the operation falls back to manual.
 */
function deriveBankCategory(row: StatementRow): string {
  const purpose = row.purpose;
  if (purpose === 'Conversion') return 'Conversion';

  if (
    purpose.startsWith('Deposit accept') ||
    purpose.startsWith('Deposit payout') ||
    purpose === 'Transfer of own funds'
  ) {
    return 'Deposit';
  }

  if (row.operationType?.startsWith('Purchase')) return 'Purchase';

  return '';
}

/**
 * Description for the classifier. For purchases — merchant (so merchant rules
 * fire across channels). Otherwise — original purpose, so a person reviewing
 * unmatched rows sees the original context.
 */
function deriveDescription(row: StatementRow): string {
  if (row.merchant) {
    const place = [row.merchantCity, row.merchantCountry].filter(Boolean).join(', ');
    return place ? `${row.merchant} (${place})` : row.merchant;
  }
  return row.purpose;
}

/** Last 4 digits of an account (digits before the trailing currency suffix). */
function shortAccount(account: string): string {
  const match = account.match(/(\d{4})[A-Z]{0,3}$/);
  return match?.[1] ?? account.slice(-4);
}

export function parsePdfStatement(doc: StatementDocument): Operation[] {
  const account = shortAccount(doc.account);
  const ops: Operation[] = [];

  for (const row of doc.rows) {
    // Debit = outflow (negative), credit = inflow (positive). At least one
    // must be present; rows with both null are service lines and skipped.
    const amount = row.credit ?? (row.debit != null ? -row.debit : null);
    if (amount === null) continue;

    ops.push({
      date: row.date,
      time: null,
      account,
      amount,
      currency: doc.currency,
      bankCategory: deriveBankCategory(row),
      mcc: null,
      description: deriveDescription(row),
    });
  }
  return ops;
}
