/**
 * Money Pro (iOS app) backup adapter.
 *
 * The .back container itself (custom `name\nlength\nbytes` format) and the
 * SQLite reading happen in the PWA layer — that part needs sql.js, which is
 * a heavy WASM module we don't want core to depend on. This module is the
 * pure-TS conversion step: given parsed rows from Money Pro's 4 tables, it
 * produces canonical mtrack shapes (`balances`, `categories`, operations).
 *
 * Money Pro model in one paragraph: `transactions` carry a positive `sum`
 * and a `transactionType` (0=normal, 2=transfer with secondCashFlowPrimaryKey
 * pointing at the destination balance). Normal transactions are linked to
 * one or more categories via `splitTransaction`; the sign of the operation
 * comes from `category.flowType` (1=income → +, 2=expense → -). Dates are
 * Unix epoch seconds.
 */

import type { ClassifiedOperation } from '../types';

export interface MpBalance {
  primaryKey: string;
  name: string | null;
  description: string | null;
  currencyKey: string | null;
  balanceType: number;
  isDeleted: number;
  isHidden: number;
}

export interface MpCategory {
  primaryKey: string;
  name: string;
  parentPrimaryKey: string | null;
  flowType: number; // 1=income, 2=expense
  isDeleted: number;
}

export interface MpTransaction {
  primaryKey: string;
  date: number; // Unix seconds
  sum: number;
  description: string | null;
  transactionType: number;
  cashFlowPrimaryKey: string;
  secondCashFlowPrimaryKey: string | null;
  secondSum: number;
  isDeleted: number;
  isHidden: number;
}

export interface MpSplit {
  primaryKey: string;
  transactionsPrimaryKey: string;
  categoryPrimaryKey: string;
  sum: number;
  index: number;
}

export interface MoneyProData {
  balances: MpBalance[];
  categories: MpCategory[];
  transactions: MpTransaction[];
  splits: MpSplit[];
}

export interface MoneyProConvertOptions {
  /** Lower bound on transaction date (inclusive). */
  fromDate?: Date;
  /** Upper bound on transaction date (inclusive — end of day). */
  toDate?: Date;
  /** Include archived/hidden balances in the balances output. */
  includeArchivedBalances?: boolean;
}

export interface ConvertedBalance {
  name: string;
  currency: string;
  type: string;
  archived: boolean;
}

export interface ConvertedCategory {
  name: string;
  parent: string;
}

export interface ConvertedMoneyPro {
  balances: ConvertedBalance[];
  categories: ConvertedCategory[];
  operations: ClassifiedOperation[];
}

function formatDate(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function balanceTypeName(t: number): string {
  if (t === 1) return 'credit';
  return '';
}

export function convertMoneyPro(
  data: MoneyProData,
  opts: MoneyProConvertOptions = {},
): ConvertedMoneyPro {
  const fromSec = opts.fromDate ? opts.fromDate.getTime() / 1000 : -Infinity;
  const toSec = opts.toDate ? opts.toDate.getTime() / 1000 + 86_399 : Infinity;

  const balanceById = new Map<string, MpBalance>();
  for (const b of data.balances) balanceById.set(b.primaryKey, b);

  // Balances: keep all visible by default; user can re-edit afterwards.
  const balances: ConvertedBalance[] = [];
  const balanceNameSeen = new Set<string>();
  for (const b of data.balances) {
    const archived = !!(b.isDeleted || b.isHidden);
    if (archived && !opts.includeArchivedBalances) continue;
    const name = (b.name || b.description || '').trim();
    if (!name) continue;
    if (balanceNameSeen.has(name)) continue;
    balanceNameSeen.add(name);
    balances.push({
      name,
      currency: b.currencyKey ?? '',
      type: balanceTypeName(b.balanceType),
      archived,
    });
  }

  // Categories: flatten parent pointers to parent names.
  const catById = new Map<string, MpCategory>();
  for (const c of data.categories) catById.set(c.primaryKey, c);

  const categories: ConvertedCategory[] = [];
  const categoryNameSeen = new Set<string>();
  for (const c of data.categories) {
    if (c.isDeleted) continue;
    if (!c.name) continue;
    if (categoryNameSeen.has(c.name)) continue;
    categoryNameSeen.add(c.name);
    const parent = c.parentPrimaryKey
      ? catById.get(c.parentPrimaryKey)?.name ?? ''
      : '';
    categories.push({ name: c.name, parent });
  }

  // Splits indexed by transaction.
  const splitsByTxn = new Map<string, MpSplit[]>();
  for (const s of data.splits) {
    const arr = splitsByTxn.get(s.transactionsPrimaryKey);
    if (arr) arr.push(s);
    else splitsByTxn.set(s.transactionsPrimaryKey, [s]);
  }

  const operations: ClassifiedOperation[] = [];

  for (const t of data.transactions) {
    if (t.isDeleted) continue;
    if (t.date < fromSec || t.date > toSec) continue;

    const date = formatDate(t.date);
    const desc = t.description ?? '';

    if (t.transactionType === 2 && t.secondCashFlowPrimaryKey) {
      // Transfer: emit both legs so reports can net them out.
      const fromBalance = balanceById.get(t.cashFlowPrimaryKey);
      const toBalance = balanceById.get(t.secondCashFlowPrimaryKey);
      if (!fromBalance || !toBalance) continue;
      const fromName = (fromBalance.name || fromBalance.description || '').trim();
      const toName = (toBalance.name || toBalance.description || '').trim();
      if (!fromName || !toName) continue;

      const absSum = Math.abs(t.sum);
      // For cross-currency transfers Money Pro stores the destination amount
      // in secondSum; same-currency transfers leave it at 0.
      const absSecond = t.secondSum && t.secondSum !== 0 ? Math.abs(t.secondSum) : absSum;

      operations.push({
        date,
        time: null,
        account: fromName,
        amount: -absSum,
        currency: fromBalance.currencyKey ?? '',
        bankCategory: '',
        mcc: null,
        description: desc,
        kind: 'transfer',
        category: null,
        counterparty: toName,
        source: 'rule',
        needsConfirmation: false,
        excluded: false,
        sourceId: `mp:${t.primaryKey}:out`,
      });
      operations.push({
        date,
        time: null,
        account: toName,
        amount: absSecond,
        currency: toBalance.currencyKey ?? '',
        bankCategory: '',
        mcc: null,
        description: desc,
        kind: 'transfer',
        category: null,
        counterparty: fromName,
        source: 'rule',
        needsConfirmation: false,
        excluded: false,
        sourceId: `mp:${t.primaryKey}:in`,
      });
      continue;
    }

    // Normal transaction: walk splits.
    const balance = balanceById.get(t.cashFlowPrimaryKey);
    if (!balance) continue;
    const balanceName = (balance.name || balance.description || '').trim();
    if (!balanceName) continue;
    const cur = balance.currencyKey ?? '';

    const splits = splitsByTxn.get(t.primaryKey) ?? [];
    if (splits.length === 0) {
      operations.push({
        date,
        time: null,
        account: balanceName,
        amount: -Math.abs(t.sum),
        currency: cur,
        bankCategory: '',
        mcc: null,
        description: desc,
        kind: 'expense',
        category: null,
        counterparty: null,
        source: 'manual',
        needsConfirmation: false,
        excluded: false,
        sourceId: `mp:${t.primaryKey}:0`,
      });
      continue;
    }

    for (const s of splits) {
      const cat = catById.get(s.categoryPrimaryKey);
      const isIncome = cat?.flowType === 1;
      const signedAmount = isIncome ? Math.abs(s.sum) : -Math.abs(s.sum);
      operations.push({
        date,
        time: null,
        account: balanceName,
        amount: signedAmount,
        currency: cur,
        bankCategory: '',
        mcc: null,
        description: desc,
        kind: isIncome ? 'income' : 'expense',
        category: cat?.name ?? null,
        counterparty: null,
        source: cat ? 'rule' : 'manual',
        needsConfirmation: false,
        excluded: false,
        sourceId: `mp:${t.primaryKey}:${s.index}`,
      });
    }
  }

  return { balances, categories, operations };
}
