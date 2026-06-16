import { describe, expect, it } from 'vitest';
import { reconcile, type ExistingOp } from './reconcile';
import type { ClassifiedOperation } from './types';

// A classified CSV op. account holds the card tail; routing resolves it to a
// balance. date is the bank's 'DD.MM.YYYY'.
function op(over: Partial<ClassifiedOperation> = {}): ClassifiedOperation {
  return {
    date: '14.05.2026',
    time: '10:00:00',
    account: '4303',
    amount: -100.5,
    currency: 'RUB',
    bankCategory: 'Shops',
    mcc: '5411',
    description: 'Store',
    kind: 'expense',
    category: null,
    counterparty: null,
    source: 'rule',
    needsConfirmation: false,
    excluded: false,
    sourceId: undefined,
    ...over,
  };
}

function existing(over: Partial<ExistingOp> = {}): ExistingOp {
  return { accountName: 'Main', amount: -100, day: '2026-05-14', ...over };
}

const ROUTING = new Map([['csv|4303', 'Main']]);
const CH = 'csv';

describe('reconcile', () => {
  it('skips an op the master already has (kopecks dropped)', () => {
    // CSV -100.50 vs master -100 (dropped kopecks): within 1 ruble → match.
    const r = reconcile([op({ amount: -100.5 })], [existing({ amount: -100 })], ROUTING, CH);
    expect(r.skipped).toHaveLength(1);
    expect(r.toAdd).toHaveLength(0);
    expect(r.ambiguous).toHaveLength(0);
  });

  it('skips when the master rounded the ruble up', () => {
    const r = reconcile([op({ amount: -100.5 })], [existing({ amount: -101 })], ROUTING, CH);
    expect(r.skipped).toHaveLength(1);
  });

  it('adds a genuinely new op (no candidate)', () => {
    const r = reconcile([op({ amount: -42.0 })], [existing({ amount: -100 })], ROUTING, CH);
    expect(r.toAdd).toHaveLength(1);
    expect(r.skipped).toHaveLength(0);
  });

  it('does not match across balances or days', () => {
    const r = reconcile(
      [op({ amount: -100 })],
      [existing({ accountName: 'Other', amount: -100 }), existing({ day: '2026-05-13', amount: -100 })],
      ROUTING,
      CH,
    );
    expect(r.toAdd).toHaveLength(1);
  });

  it('flags an amount difference of a ruble or more as new, not a match', () => {
    const r = reconcile([op({ amount: -100 })], [existing({ amount: -101 })], ROUTING, CH);
    expect(r.toAdd).toHaveLength(1);
    expect(r.skipped).toHaveLength(0);
  });

  it('asks when more than one candidate matches', () => {
    const r = reconcile(
      [op({ amount: -100 })],
      [existing({ amount: -100 }), existing({ amount: -100.4 })],
      ROUTING,
      CH,
    );
    expect(r.ambiguous).toHaveLength(1);
    expect(r.ambiguous[0]!.reason).toBe('multiple-matches');
    expect(r.ambiguous[0]!.candidates).toHaveLength(2);
  });

  it('asks about an unmatched op that looks like a transfer', () => {
    const r = reconcile([op({ amount: -500, kind: 'transfer' })], [], ROUTING, CH);
    expect(r.ambiguous).toHaveLength(1);
    expect(r.ambiguous[0]!.reason).toBe('unmatched-transfer');
    expect(r.toAdd).toHaveLength(0);
  });

  it('adds an unmatched non-transfer op even on a day with other activity', () => {
    const r = reconcile(
      [op({ amount: -42 })],
      [existing({ amount: -100 }), existing({ amount: -7 })],
      ROUTING,
      CH,
    );
    expect(r.toAdd).toHaveLength(1);
    expect(r.ambiguous).toHaveLength(0);
  });
});
