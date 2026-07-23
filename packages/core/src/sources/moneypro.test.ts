import { describe, expect, it } from 'vitest';
import { convertMoneyPro, type MoneyProData } from './moneypro';

/**
 * One active balance ("Main") and one hidden/archived balance ("Ozon") that
 * has a transaction. Money Pro keeps closed cards as hidden balances, so this
 * mirrors the real "archived card still has history" case.
 */
function fixture(): MoneyProData {
  return {
    balances: [
      {
        primaryKey: '1',
        name: 'Main',
        description: null,
        currencyKey: 'USD',
        balanceType: 0,
        isDeleted: 0,
        isHidden: 0,
      },
      {
        primaryKey: '2',
        name: 'Ozon',
        description: null,
        currencyKey: 'RUB',
        balanceType: 0,
        isDeleted: 0,
        isHidden: 1, // archived
      },
    ],
    categories: [
      { primaryKey: 'c1', name: 'Food', parentPrimaryKey: null, flowType: 2, isDeleted: 0 },
    ],
    transactions: [
      {
        primaryKey: 't1',
        date: 1_700_000_000,
        sum: 100,
        description: 'coffee',
        transactionType: 0,
        cashFlowPrimaryKey: '2', // on the archived "Ozon" balance
        secondCashFlowPrimaryKey: null,
        secondSum: 0,
        isDeleted: 0,
        isHidden: 0,
      },
    ],
    splits: [
      { primaryKey: 's1', transactionsPrimaryKey: 't1', categoryPrimaryKey: 'c1', sum: 100, index: 0 },
    ],
  };
}

describe('convertMoneyPro archived balances', () => {
  it('by default drops the archived balance but keeps its operations (the orphan case)', () => {
    const out = convertMoneyPro(fixture());
    expect(out.balances.map((b) => b.name)).toEqual(['Main']); // Ozon excluded
    // ...yet the Ozon transaction still imports, leaving its card unroutable.
    expect(out.operations.map((o) => o.account)).toContain('Ozon');
  });

  it('includes the archived balance (flagged archived) when asked', () => {
    const out = convertMoneyPro(fixture(), { includeArchivedBalances: true });
    const ozon = out.balances.find((b) => b.name === 'Ozon');
    expect(ozon).toBeDefined();
    expect(ozon?.archived).toBe(true);
    expect(out.balances.find((b) => b.name === 'Main')?.archived).toBe(false);
  });
});

describe('convertMoneyPro balance adjustments (types 7 and 8)', () => {
  const txn = (over: Partial<MoneyProData['transactions'][number]>) => ({
    primaryKey: 'ta',
    date: 1_700_000_000,
    sum: 0,
    description: null,
    transactionType: 7,
    cashFlowPrimaryKey: '1',
    secondCashFlowPrimaryKey: null,
    secondSum: 0,
    isDeleted: 0,
    isHidden: 0,
    ...over,
  });

  it('keeps the sign of an opening balance (type 7) and marks it income', () => {
    const data = fixture();
    data.transactions = [txn({ sum: 17_065_000 })];
    data.splits = [];
    const [op] = convertMoneyPro(data).operations;
    // The regression: the no-split expense branch forced this to -17,065,000.
    expect(op).toMatchObject({
      amount: 17_065_000,
      kind: 'income',
      category: 'Balance adjustment',
      description: 'Balance adjustment',
    });
  });

  it('keeps a negative reconciliation (type 8) as a signed expense', () => {
    const data = fixture();
    data.transactions = [txn({ transactionType: 8, sum: -20_592 })];
    data.splits = [];
    const [op] = convertMoneyPro(data).operations;
    expect(op).toMatchObject({ amount: -20_592, kind: 'expense', category: 'Balance adjustment' });
  });
});
