/**
 * Reconciles freshly-parsed CSV operations against what's already in the sheet.
 *
 * Money Pro is the curated master, so a CSV operation that already exists there
 * must not be re-added. Matching tolerates the ways a manual Money Pro entry
 * drifts from the bank's record:
 *   - time differs (manual entry), but the calendar day does not → match on day;
 *   - kopecks were dropped or the ruble rounded up → amounts match within < 1 ₽.
 *
 * Per CSV op: exactly one existing op on the same balance + day + amount means
 * the master already has it (including when it's stored as a transfer leg) → it
 * is skipped. None means it's new → added, unless the op itself looks like a
 * transfer, in which case it's surfaced for review so a cross-account move isn't
 * booked as a plain expense. More than one candidate is ambiguous → review.
 */

import type { ClassifiedOperation } from './types';

/** A pre-existing operation row, reduced to what matching needs. */
export interface ExistingOp {
  accountName: string;
  amount: number;
  /** Calendar day, 'YYYY-MM-DD'. */
  day: string;
}

export type AmbiguityReason = 'multiple-matches' | 'unmatched-transfer';

export interface AmbiguousItem {
  op: ClassifiedOperation;
  candidates: ExistingOp[];
  reason: AmbiguityReason;
}

export interface ReconcileResult {
  toAdd: ClassifiedOperation[];
  skipped: ClassifiedOperation[];
  ambiguous: AmbiguousItem[];
}

// Manual entries dropped kopecks or rounded the ruble up, so two amounts match
// when they differ by less than a whole ruble.
const AMOUNT_TOLERANCE = 1;

/** 'DD.MM.YYYY' (CSV op date) -> 'YYYY-MM-DD' (operations-tab day). */
function csvDay(date: string): string {
  const [dd, mm, yyyy] = date.split('.');
  return `${yyyy}-${mm}-${dd}`;
}

function sameAmount(a: number, b: number): boolean {
  return Math.abs(a - b) < AMOUNT_TOLERANCE;
}

export function reconcile(
  csvOps: ClassifiedOperation[],
  existing: ExistingOp[],
  routing: Map<string, string>,
  channel: string,
): ReconcileResult {
  // Group existing ops by balance + day for quick candidate lookup.
  const byKey = new Map<string, ExistingOp[]>();
  for (const e of existing) {
    const key = `${e.accountName}|${e.day}`;
    const arr = byKey.get(key);
    if (arr) arr.push(e);
    else byKey.set(key, [e]);
  }

  const toAdd: ClassifiedOperation[] = [];
  const skipped: ClassifiedOperation[] = [];
  const ambiguous: AmbiguousItem[] = [];

  for (const op of csvOps) {
    const balance = routing.get(`${channel}|${op.account ?? ''}`) ?? '';
    const day = csvDay(op.date);
    const candidates = (byKey.get(`${balance}|${day}`) ?? []).filter((e) =>
      sameAmount(e.amount, op.amount),
    );

    if (candidates.length === 1) {
      skipped.push(op);
    } else if (candidates.length > 1) {
      ambiguous.push({ op, candidates, reason: 'multiple-matches' });
    } else if (op.kind === 'transfer') {
      ambiguous.push({ op, candidates: [], reason: 'unmatched-transfer' });
    } else {
      toAdd.push(op);
    }
  }

  return { toAdd, skipped, ambiguous };
}
