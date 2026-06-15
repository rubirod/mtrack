import { describe, expect, it } from 'vitest';
import { upsertAccountRouting, type RoutingEntry } from './accounts-routing';
import type { Cell, Row, SheetsAPI, ValueRange } from './sheets-api';

/**
 * Fake `accounts` tab backed by a grid (row 0 is the header). Implements just
 * the calls upsertAccountRouting makes, faithfully enough to assert that a
 * targeted balance-column write preserves the rest of each row.
 */
function makeFake(initial: Cell[][]): { api: SheetsAPI; grid: Cell[][] } {
  const grid: Cell[][] = initial.map((r) => [...r]);
  const api: SheetsAPI = {
    async getValues(range: string): Promise<string[][]> {
      const ref = range.split('!')[1] ?? '';
      const startRow = parseInt(ref.split(':')[0]!.replace(/[A-Z]/g, ''), 10) - 1;
      return grid.slice(startRow).map((r) => [String(r[0] ?? ''), String(r[1] ?? '')]);
    },
    async updateValues(_range: string, values: Row[]): Promise<void> {
      grid[0] = values[0]!.map((c) => c ?? '');
    },
    async appendValues(_range: string, values: Row[]): Promise<void> {
      for (const r of values) grid.push([...r]);
    },
    async batchUpdateValues(data: ValueRange[]): Promise<void> {
      for (const { range, values } of data) {
        const ref = range.split('!')[1]!;
        const col = ref.charCodeAt(0) - 65;
        const rowNum = parseInt(ref.slice(1), 10);
        const row = (grid[rowNum - 1] ??= []);
        row[col] = values[0]![0]!;
      }
    },
    async listTabs(): Promise<string[]> {
      return ['accounts'];
    },
    async ensureTab(): Promise<void> {},
    async clearRange(): Promise<void> {},
  };
  return { api, grid };
}

// A hand-extended accounts tab: managed columns A-C plus user columns D-G.
function richAccounts(): Cell[][] {
  return [
    ['sourceChannel', 'tail', 'accountName', 'bank', 'type', 'currency', 'matchBy'],
    ['csv', '7277', 'Main', 'Acme', 'credit', 'USD', 'tail'], // sheet row 2
    ['manual', 'wallet', 'Wallet', '', '', '', ''], // sheet row 3
  ];
}

describe('upsertAccountRouting', () => {
  it('updates only the balance column and preserves extra columns', async () => {
    const { api, grid } = makeFake(richAccounts());
    const entries: RoutingEntry[] = [
      { sourceChannel: 'manual', tail: 'wallet', balance: 'Wallet Renamed' },
    ];
    const res = await upsertAccountRouting(api, entries);

    expect(res).toEqual({ updated: 1, appended: 0 });
    expect(grid[2]![2]).toBe('Wallet Renamed'); // balance updated
    expect(grid[2]!.slice(3)).toEqual(['', '', '', '']); // user columns intact
  });

  it('leaves rows that are not in the editor untouched', async () => {
    const { api, grid } = makeFake(richAccounts());
    // Only routes "wallet"; the csv card is not in the (operations-derived) list.
    await upsertAccountRouting(api, [
      { sourceChannel: 'manual', tail: 'wallet', balance: 'Wallet Renamed' },
    ]);
    expect(grid[1]).toEqual(['csv', '7277', 'Main', 'Acme', 'credit', 'USD', 'tail']);
  });

  it('appends genuinely new instruments', async () => {
    const { api, grid } = makeFake(richAccounts());
    const res = await upsertAccountRouting(api, [
      { sourceChannel: 'manual', tail: 'new', balance: 'New Acct' },
    ]);
    expect(res).toEqual({ updated: 0, appended: 1 });
    expect(grid[grid.length - 1]).toEqual(['manual', 'new', 'New Acct']);
  });

  it('clears an existing routing when the balance is emptied', async () => {
    const { api, grid } = makeFake(richAccounts());
    await upsertAccountRouting(api, [{ sourceChannel: 'manual', tail: 'wallet', balance: '' }]);
    expect(grid[2]![2]).toBe(''); // unrouted
    expect(grid.length).toBe(3); // no spurious append
  });
});
