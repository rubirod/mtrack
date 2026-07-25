import { describe, expect, it } from 'vitest';
import {
  mergeMerchantPicks,
  type CounterpartyRuleRow,
  type MerchantRuleRow,
} from './rules-merge';

const cp = (over: Partial<CounterpartyRuleRow> = {}): CounterpartyRuleRow => ({
  match: 'm',
  kind: 'transfer',
  label: 'L',
  category: '',
  suggest: '',
  excluded: '',
  field: 'description',
  tail: '',
  ...over,
});

/** The shape that actually bit: two rules sharing a match, split by scope. */
function fixture(): { merchant: MerchantRuleRow[]; counterparty: CounterpartyRuleRow[] } {
  return {
    merchant: [
      { match: 'park', category: 'Eating out', bankCategory: 'Fastfood' },
      { match: 'park', category: 'Entertainment', bankCategory: 'Art' },
      { match: 'netflix', category: 'Subscriptions', bankCategory: '' },
    ],
    counterparty: [
      cp({ match: 'cash', kind: 'transfer', label: 'Business cash', excluded: 'true', tail: '4588', field: 'bankCategory' }),
      cp({ match: 'cash', kind: 'transfer', label: 'Cash', field: 'bankCategory' }),
      cp({ match: 'employer', kind: 'income', label: 'Employer' }),
    ],
  };
}

describe('mergeMerchantPicks', () => {
  it('keeps scoped twins that share a match string', () => {
    const f = fixture();
    const out = mergeMerchantPicks(f.merchant, f.counterparty, [
      { merchant: 'netflix', picked: 'exp:Media' },
    ]);

    expect(out.merchantRules.filter((r) => r.match === 'park')).toEqual([
      { match: 'park', category: 'Eating out', bankCategory: 'Fastfood' },
      { match: 'park', category: 'Entertainment', bankCategory: 'Art' },
    ]);
    // Both cash rules survive, the tail-scoped one first — order is what makes
    // first-match-wins mean the right thing.
    expect(out.counterpartyRules.map((r) => `${r.match}|${r.tail}`)).toEqual([
      'cash|4588',
      'cash|',
      'employer|',
    ]);
    expect(out.merchantRules.find((r) => r.match === 'netflix')?.category).toBe('Media');
  });

  it('adds a new unscoped merchant rule without touching the scoped ones', () => {
    const f = fixture();
    const out = mergeMerchantPicks(f.merchant, f.counterparty, [
      { merchant: 'park', picked: 'exp:Leisure' },
    ]);

    expect(out.merchantRules).toEqual([
      { match: 'park', category: 'Eating out', bankCategory: 'Fastfood' },
      { match: 'park', category: 'Entertainment', bankCategory: 'Art' },
      { match: 'netflix', category: 'Subscriptions', bankCategory: '' },
      { match: 'park', category: 'Leisure', bankCategory: '' },
    ]);
  });

  it('a transfer pick replaces the unscoped merchant rule, keeping scoped ones', () => {
    const f = fixture();
    const out = mergeMerchantPicks(f.merchant, f.counterparty, [
      { merchant: 'netflix', picked: 'trf:Savings' },
    ]);

    expect(out.merchantRules.some((r) => r.match === 'netflix')).toBe(false);
    expect(out.counterpartyRules.at(-1)).toMatchObject({
      match: 'netflix',
      kind: 'transfer',
      label: 'Savings',
      tail: '',
    });
  });

  it('an expense pick drops only the unscoped counterparty rule', () => {
    const f = fixture();
    const out = mergeMerchantPicks(f.merchant, f.counterparty, [
      { merchant: 'cash', picked: 'exp:Withdrawals' },
    ]);

    expect(out.counterpartyRules.map((r) => `${r.match}|${r.tail}`)).toEqual([
      'cash|4588', // the scoped rule is not the editor's to remove
      'employer|',
    ]);
    expect(out.merchantRules.at(-1)).toEqual({
      match: 'cash',
      category: 'Withdrawals',
      bankCategory: '',
    });
  });

  it('updates an existing unscoped rule in place rather than appending', () => {
    const f = fixture();
    const out = mergeMerchantPicks(f.merchant, f.counterparty, [
      { merchant: 'employer', picked: 'peer' },
    ]);

    expect(out.counterpartyRules).toHaveLength(3);
    expect(out.counterpartyRules[2]).toMatchObject({ match: 'employer', kind: 'peer' });
  });

  it('ignores empty and unknown picks', () => {
    const f = fixture();
    const out = mergeMerchantPicks(f.merchant, f.counterparty, [
      { merchant: 'netflix', picked: '' },
      { merchant: 'netflix', picked: 'wat:Nope' },
    ]);
    expect(out.merchantRules).toEqual(f.merchant);
    expect(out.counterpartyRules).toEqual(f.counterparty);
  });
});
