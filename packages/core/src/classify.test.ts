import { describe, expect, it } from 'vitest';
import { classify } from './classify';
import type { ClassifyConfig } from './categories';
import type { Operation } from './types';

function op(over: Partial<Operation> = {}): Operation {
  return {
    date: '14.05.2026',
    time: '10:00:00',
    account: '1234',
    amount: -100,
    currency: 'RUB',
    bankCategory: 'Shops',
    mcc: '5411',
    description: 'Store',
    ...over,
  };
}

function config(over: Partial<ClassifyConfig> = {}): ClassifyConfig {
  return {
    bankCategoryMap: new Map([['Shops', 'Groceries']]),
    merchantRules: [],
    counterpartyRules: [],
    ...over,
  };
}

describe('classify', () => {
  it('maps a bank category to a user category (expense fallback)', () => {
    const r = classify(op(), config());
    expect(r).toMatchObject({ kind: 'expense', category: 'Groceries', source: 'rule' });
  });

  it('leaves an unmapped expense without a category', () => {
    const r = classify(op({ bankCategory: 'Unknown' }), config());
    expect(r).toMatchObject({ kind: 'expense', category: null, source: 'manual' });
  });

  it('a merchant rule overrides the bank-category map', () => {
    const r = classify(
      op({ description: 'COFFEE BAR' }),
      config({ merchantRules: [{ match: 'coffee', category: 'Eating out' }] }),
    );
    expect(r.category).toBe('Eating out');
  });

  it('narrows a merchant rule to a bank category, splitting one merchant', () => {
    const cfg = config({
      merchantRules: [
        { match: 'park', category: 'Eating out', bankCategory: 'Fastfood' },
        { match: 'park', category: 'Entertainment', bankCategory: 'Art' },
      ],
    });

    expect(classify(op({ description: 'CITY PARK', bankCategory: 'Fastfood' }), cfg).category).toBe(
      'Eating out',
    );
    expect(classify(op({ description: 'CITY PARK', bankCategory: 'Art' }), cfg).category).toBe(
      'Entertainment',
    );
  });

  it('applies a tail-scoped rule only to the matching card', () => {
    const cfg = config({
      counterpartyRules: [
        // Card-scoped first: cash-out on 4588 is excluded.
        { match: 'cash', field: 'bankCategory', kind: 'transfer', label: 'Ignored', excluded: true, tail: '4588' },
        // General cash rule for every other card.
        { match: 'cash', field: 'bankCategory', kind: 'transfer', label: 'Cash' },
      ],
    });

    const onScoped = classify(op({ account: '4588', bankCategory: 'cash' }), cfg);
    expect(onScoped).toMatchObject({ kind: 'transfer', counterparty: 'Ignored', excluded: true });

    const onOther = classify(op({ account: '1234', bankCategory: 'cash' }), cfg);
    expect(onOther).toMatchObject({ kind: 'transfer', counterparty: 'Cash', excluded: false });
  });
});
