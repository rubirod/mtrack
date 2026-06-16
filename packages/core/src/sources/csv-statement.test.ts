import { describe, expect, it } from 'vitest';
import { parseCsvStatement } from './csv-statement';

// 15-column statement rows (header line is ignored). Columns:
// 0 datetime | 1 paydate | 2 card | 3 status | 4 op-amount | 5 op-currency |
// 6 settle-amount | 7 settle-currency | 8 cashback | 9 category | 10 mcc |
// 11 description | 12 bonus | 13 rounding | 14 rounded.
function csv(...rows: string[]): string {
  const header = '"a";"b";"c";"d";"e";"f";"g";"h";"i";"j";"k";"l";"m";"n";"o"';
  return [header, ...rows].join('\n');
}

const RUB =
  '"01.05.2026 10:00:00";"01.05.2026";"*1234";"OK";"-100,00";"RUB";"-100,00";"RUB";"";"Food";"5411";"Shop";"0,00";"0,00";"-100,00"';
// Foreign-currency buy: original USD amount in col 4/5, settled RUB in col 6/7.
const USD =
  '"02.05.2026 11:00:00";"02.05.2026";"*1234";"OK";"-10,00";"USD";"-950,00";"RUB";"";"Travel";"4111";"Hotel";"0,00";"0,00";"-950,00"';
const DECLINED =
  '"03.05.2026 12:00:00";"03.05.2026";"*1234";"FAILED";"-5,00";"RUB";"-5,00";"RUB";"";"Food";"5411";"Shop";"0,00";"0,00";"-5,00"';

describe('parseCsvStatement', () => {
  it('keeps only OK rows', () => {
    const ops = parseCsvStatement(csv(RUB, DECLINED));
    expect(ops).toHaveLength(1);
    expect(ops[0]!.description).toBe('Shop');
  });

  it('pairs the settled amount with the settled currency', () => {
    const [op] = parseCsvStatement(csv(RUB));
    expect(op).toMatchObject({ amount: -100, currency: 'RUB', account: '1234', bankCategory: 'Food', mcc: '5411' });
  });

  it('records a foreign-currency op in its settled (account) currency, not the original', () => {
    const [op] = parseCsvStatement(csv(USD));
    // Was buggy: amount -950 (RUB) but currency "USD". Now both are RUB.
    expect(op!.amount).toBe(-950);
    expect(op!.currency).toBe('RUB');
  });
});
