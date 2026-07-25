import { describe, expect, it } from 'vitest';
import {
  applyBalanceMigration,
  previewBalanceMigration,
} from './balance-migration';
import type { Cell, Row, SheetsAPI, ValueRange } from './sheets-api';

/**
 * Fake spreadsheet with the four tabs the migration touches. `operations`
 * carries only the columns the migration reads: accountName = D (index 3),
 * counterparty = G (6), updatedAt = S (18).
 */
type Grid = Cell[][];

function makeFake(tabs: Record<string, Grid>): { api: SheetsAPI; tabs: Record<string, Grid> } {
  const store: Record<string, Grid> = Object.fromEntries(
    Object.entries(tabs).map(([name, grid]) => [name, grid.map((r) => [...r])]),
  );

  function parseRef(range: string): { tab: string; ref: string } {
    const [tab, ref] = range.split('!');
    return { tab: tab!, ref: ref ?? '' };
  }

  function colIndex(letters: string): number {
    return letters.charCodeAt(0) - 65;
  }

  const api: SheetsAPI = {
    async getValues(range: string): Promise<string[][]> {
      const { tab, ref } = parseRef(range);
      const grid = store[tab];
      if (!grid) throw new Error(`no tab ${tab}`);
      if (ref === '1:1') return [grid[0]!.map((c) => String(c ?? ''))];
      const m = ref.match(/^([A-Z])(\d+):([A-Z])?(\d*)$/);
      if (!m) throw new Error(`unsupported ref ${ref}`);
      const fromCol = colIndex(m[1]!);
      const fromRow = parseInt(m[2]!, 10) - 1;
      const toCol = m[3] ? colIndex(m[3]) : 25;
      return grid
        .slice(fromRow)
        .map((r) => r.slice(fromCol, toCol + 1).map((c) => String(c ?? '')));
    },
    async updateValues(): Promise<void> {
      throw new Error('migration must not rewrite ranges');
    },
    async appendValues(): Promise<void> {
      throw new Error('migration must not append');
    },
    async batchUpdateValues(data: ValueRange[]): Promise<void> {
      for (const { range, values } of data) {
        const { tab, ref } = parseRef(range);
        const grid = store[tab]!;
        const m = ref.match(/^([A-Z])(\d+)$/);
        if (!m) throw new Error(`unsupported write ref ${ref}`);
        const col = colIndex(m[1]!);
        const rowNum = parseInt(m[2]!, 10) - 1;
        const row = (grid[rowNum] ??= []);
        row[col] = values[0]![0]!;
      }
    },
    async listTabs(): Promise<string[]> {
      return Object.keys(store);
    },
    async ensureTab(): Promise<void> {},
    async clearRange(): Promise<void> {},
  };
  return { api, tabs: store };
}

let seq = 0;

function opRow(accountName: string, counterparty: string): Row {
  const row: Cell[] = new Array(19).fill('');
  row[0] = `id-${++seq}`;
  row[3] = accountName;
  row[6] = counterparty;
  row[18] = '2026-01-01T00:00:00.000Z';
  return row;
}

function fixture(): Record<string, Grid> {
  return {
    balances: [
      ['name', 'currency', 'type', 'archived'],
      ['Cash RUB', 'RUB', 'cash', ''],
      ['Wallet', 'RUB', 'cash', ''],
      ['Main card', 'RUB', 'card', ''],
    ],
    accounts: [
      ['sourceChannel', 'tail', 'balance'],
      ['backup', '', 'Cash RUB'],
      ['bank-csv', '1234', 'Main card'],
    ],
    counterparty_rules: [
      ['match', 'kind', 'label', 'category', 'suggest', 'excluded', 'field', 'tail'],
      ['atm', 'transfer', 'Cash RUB', '', '', '', 'description', ''],
      ['savings', 'transfer', 'Savings', '', '', '', 'description', ''],
    ],
    operations: [
      [...'ABCDEFGHIJKLMNOPQRS'].map((c) => `col${c}`),
      opRow('Cash RUB', ''),
      opRow('Main card', 'Cash RUB'),
      opRow('Wallet', ''),
      opRow('Cash RUB', 'Wallet'), // both columns migrate on one row
      opRow('Main card', 'Savings'),
    ],
  };
}

describe('previewBalanceMigration', () => {
  it('counts references in all four places without writing', async () => {
    const { api, tabs } = makeFake(fixture());
    const before = JSON.stringify(tabs);

    const report = await previewBalanceMigration(api, [{ from: 'Cash RUB', to: 'Wallet' }]);

    expect(report.renames[0]).toMatchObject({
      from: 'Cash RUB',
      to: 'Wallet',
      merge: true, // Wallet already exists
      balanceRows: 1,
      routingRefs: 1,
      ruleLabelRefs: 1,
      accountNameRows: 2,
      counterpartyRows: 1,
    });
    expect(JSON.stringify(tabs)).toBe(before); // dry run
  });

  it('reports a plain rename when the target is new', async () => {
    const { api } = makeFake(fixture());

    const report = await previewBalanceMigration(api, [{ from: 'Cash RUB', to: 'Petty cash' }]);

    expect(report.renames[0]!.merge).toBe(false);
  });

  it('rejects chained renames and duplicate sources', async () => {
    const { api } = makeFake(fixture());
    await expect(
      previewBalanceMigration(api, [
        { from: 'Cash RUB', to: 'Wallet' },
        { from: 'Wallet', to: 'Main card' },
      ]),
    ).rejects.toThrow(/[Cc]hained/);
    await expect(
      previewBalanceMigration(api, [
        { from: 'Cash RUB', to: 'Wallet' },
        { from: 'Cash RUB', to: 'Main card' },
      ]),
    ).rejects.toThrow(/[Dd]uplicate/);
  });
});

describe('applyBalanceMigration', () => {
  it('renames in place across config tabs and both operations columns', async () => {
    const { api, tabs } = makeFake(fixture());

    await applyBalanceMigration(api, [{ from: 'Cash RUB', to: 'Petty cash' }]);

    expect(tabs.balances![1]![0]).toBe('Petty cash'); // renamed in place
    expect(tabs.balances![1]![1]).toBe('RUB'); // currency kept on a rename
    expect(tabs.accounts![1]![2]).toBe('Petty cash'); // routing repointed
    expect(tabs.counterparty_rules![1]![2]).toBe('Petty cash'); // rule label
    expect(tabs.operations![1]![3]).toBe('Petty cash');
    expect(tabs.operations![2]![6]).toBe('Petty cash');
    expect(tabs.operations![4]![3]).toBe('Petty cash');
    expect(tabs.operations![1]![18]).not.toBe('2026-01-01T00:00:00.000Z'); // updatedAt bumped
    expect(tabs.operations![5]![3]).toBe('Main card'); // untouched row stays
    expect(tabs.operations![5]![18]).toBe('2026-01-01T00:00:00.000Z');
  });

  it('merging clears the source balances row and repoints references', async () => {
    const { api, tabs } = makeFake(fixture());

    await applyBalanceMigration(api, [{ from: 'Cash RUB', to: 'Wallet' }]);

    expect(tabs.balances![1]!.slice(0, 4)).toEqual(['', '', '', '']); // row blanked
    expect(tabs.balances![2]![0]).toBe('Wallet'); // target row untouched
    expect(tabs.accounts![1]![2]).toBe('Wallet'); // instrument now feeds Wallet
    expect(tabs.operations![1]![3]).toBe('Wallet');
    expect(tabs.operations![2]![6]).toBe('Wallet');
    // A row matching in both columns migrates both.
    expect(tabs.operations![4]![3]).toBe('Wallet');
    expect(tabs.operations![4]![6]).toBe('Wallet');
  });

  it('aborts the operations write when the tab changed underneath', async () => {
    const base = fixture();
    const { api, tabs } = makeFake(base);

    let reads = 0;
    const realGet = api.getValues.bind(api);
    api.getValues = async (range: string) => {
      if (range.startsWith('operations!D2')) {
        reads++;
        if (reads === 2) tabs.operations!.push(opRow('Cash RUB', ''));
      }
      return realGet(range);
    };

    await expect(
      applyBalanceMigration(api, [{ from: 'Cash RUB', to: 'Wallet' }]),
    ).rejects.toThrow(/changed while/);
    expect(tabs.operations![1]![3]).toBe('Cash RUB'); // not written with stale indices
  });
});
