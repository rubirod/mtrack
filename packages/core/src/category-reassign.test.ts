import { describe, expect, it } from 'vitest';
import { applyCategoryReassign, previewCategoryReassign } from './category-reassign';
import type { Cell, Row, SheetsAPI, ValueRange } from './sheets-api';

/**
 * Fake spreadsheet shaped like the real tabs. `operations` carries only what
 * the move reads: category = F (index 5), updatedAt = S (18).
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
  const colIndex = (letters: string): number => letters.charCodeAt(0) - 65;

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
      throw new Error('reassign must not rewrite ranges');
    },
    async appendValues(): Promise<void> {
      throw new Error('reassign must not append');
    },
    async batchUpdateValues(data: ValueRange[]): Promise<void> {
      for (const { range, values } of data) {
        const { tab, ref } = parseRef(range);
        const m = ref.match(/^([A-Z])(\d+)$/);
        if (!m) throw new Error(`unsupported write ref ${ref}`);
        const row = (store[tab]![parseInt(m[2]!, 10) - 1] ??= []);
        row[colIndex(m[1]!)] = values[0]![0]!;
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
function opRow(category: string): Row {
  const row: Cell[] = new Array(19).fill('');
  row[0] = `id-${++seq}`;
  row[5] = category;
  row[18] = '2026-01-01T00:00:00.000Z';
  return row;
}

function fixture(): Record<string, Grid> {
  return {
    categories: [
      ['name', 'parent'],
      ['Transport', ''], // group: holds operations of its own, plus children
      ['Taxi', 'Transport'],
      ['Public transport', 'Transport'],
      ['Food', ''],
    ],
    bank_category_map: [
      ['bankCategory', 'category'],
      ['Local transit', 'Transport'],
      ['Groceries', 'Food'],
    ],
    merchant_rules: [
      ['match', 'category', 'bankCategory'],
      ['metro', 'Transport', ''],
      ['bakery', 'Food', ''],
    ],
    counterparty_rules: [
      ['match', 'kind', 'label', 'category', 'suggest', 'excluded', 'field', 'tail'],
      ['commuting', 'transfer', 'Commute', 'Transport', '', '', 'description', ''],
    ],
    operations: [
      [...'ABCDEFGHIJKLMNOPQRS'].map((c) => `col${c}`),
      opRow('Transport'),
      opRow('Taxi'),
      opRow('Transport'),
      opRow('Food'),
    ],
  };
}

describe('previewCategoryReassign', () => {
  it('counts the operations and rules a move would touch, writing nothing', async () => {
    const { api, tabs } = makeFake(fixture());
    const before = JSON.stringify(tabs);

    const report = await previewCategoryReassign(api, [
      { from: 'Transport', to: 'Public transport' },
    ]);

    expect(report.moves[0]).toMatchObject({
      from: 'Transport',
      to: 'Public transport',
      operationRows: 2,
      bankMapRefs: 1,
      merchantRuleRefs: 1,
      counterpartyRuleRefs: 1,
    });
    expect(JSON.stringify(tabs)).toBe(before);
  });

  it('refuses a target that groups other categories', async () => {
    const { api } = makeFake(fixture());
    await expect(
      previewCategoryReassign(api, [{ from: 'Taxi', to: 'Transport' }]),
    ).rejects.toThrow(/child categories/);
  });

  it('refuses a target that is not in the categories tab', async () => {
    const { api } = makeFake(fixture());
    await expect(
      previewCategoryReassign(api, [{ from: 'Taxi', to: 'Buses' }]),
    ).rejects.toThrow(/not in the categories tab/);
  });
});

describe('applyCategoryReassign', () => {
  it('moves operations and repoints rules, leaving the tree untouched', async () => {
    const { api, tabs } = makeFake(fixture());

    await applyCategoryReassign(api, [{ from: 'Transport', to: 'Public transport' }]);

    // Operations moved.
    expect(tabs.operations![1]![5]).toBe('Public transport');
    expect(tabs.operations![3]![5]).toBe('Public transport');
    expect(tabs.operations![1]![18]).not.toBe('2026-01-01T00:00:00.000Z');
    // Untouched rows stay.
    expect(tabs.operations![2]![5]).toBe('Taxi');
    expect(tabs.operations![4]![5]).toBe('Food');
    // Rules follow, so "Apply now" agrees with the move.
    expect(tabs.bank_category_map![1]![1]).toBe('Public transport');
    expect(tabs.merchant_rules![1]![1]).toBe('Public transport');
    expect(tabs.counterparty_rules![1]![3]).toBe('Public transport');
    // The tree is exactly as it was: the group survives and keeps its children.
    expect(tabs.categories).toEqual([
      ['name', 'parent'],
      ['Transport', ''],
      ['Taxi', 'Transport'],
      ['Public transport', 'Transport'],
      ['Food', ''],
    ]);
  });

  it('aborts the operations write when the tab changed underneath', async () => {
    const base = fixture();
    const { api, tabs } = makeFake(base);

    let reads = 0;
    const realGet = api.getValues.bind(api);
    api.getValues = async (range: string) => {
      if (range.startsWith('operations!F2')) {
        reads++;
        if (reads === 2) tabs.operations!.push(opRow('Transport'));
      }
      return realGet(range);
    };

    await expect(
      applyCategoryReassign(api, [{ from: 'Transport', to: 'Public transport' }]),
    ).rejects.toThrow(/changed while/);
    expect(tabs.operations![1]![5]).toBe('Transport');
  });
});
