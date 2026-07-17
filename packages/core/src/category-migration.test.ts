import { describe, expect, it } from 'vitest';
import {
  applyCategoryMigration,
  previewCategoryMigration,
  type CategoryRename,
} from './category-migration';
import type { Cell, Row, SheetsAPI, ValueRange } from './sheets-api';

/**
 * Fake spreadsheet with the five tabs the migration touches. Column layouts
 * follow the seeded canon; `operations` carries only the columns the
 * migration reads (category = F, updatedAt = S), the rest are blank.
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
      // Supported refs: "1:1", "A2:Z", "F2:F".
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

function opRow(category: string): Row {
  // id..updatedAt = 19 columns; category is index 5, updatedAt is 18.
  const row: Cell[] = new Array(19).fill('');
  row[0] = `id-${Math.abs(hash(category + Math.random()))}`;
  row[5] = category;
  row[18] = '2026-01-01T00:00:00.000Z';
  return row;
}

function hash(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}

function fixture(): Record<string, Grid> {
  return {
    categories: [
      ['name', 'parent'],
      ['Salary', ''],
      ['Beauty', 'Lifestyle'],
      ['Grooming', 'Lifestyle'],
      ['Food', ''],
      ['Eating out', 'Salary'], // nonsense parent, but exercises parent refs
    ],
    bank_category_map: [
      ['bankCategory', 'category'],
      ['Paycheck', 'Salary'],
      ['Barber', 'Grooming'],
      ['Groceries', 'Food'],
    ],
    merchant_rules: [
      ['match', 'category', 'bankCategory'],
      ['barbershop', 'Grooming', ''],
      ['bonus', 'Salary', 'Other'],
    ],
    counterparty_rules: [
      ['match', 'kind', 'label', 'category', 'suggest', 'excluded', 'field', 'tail'],
      ['employer', 'income', 'Employer', 'Salary', '', '', 'description', ''],
    ],
    operations: [
      [...'ABCDEFGHIJKLMNOPQRS'].map((c) => `col${c}`),
      opRow('Salary'),
      opRow('Grooming'),
      opRow('Food'),
      opRow('Salary'),
    ],
  };
}

describe('previewCategoryMigration', () => {
  it('counts references in all five places without writing', async () => {
    const { api, tabs } = makeFake(fixture());
    const before = JSON.stringify(tabs);

    const report = await previewCategoryMigration(api, [
      { from: 'Salary', to: 'Wages' },
      { from: 'Grooming', to: 'Beauty' },
    ]);

    const salary = report.renames.find((r) => r.from === 'Salary')!;
    expect(salary).toMatchObject({
      merge: false,
      categoryRows: 1,
      parentRefs: 1, // Eating out's parent
      bankMapRefs: 1,
      merchantRuleRefs: 1,
      counterpartyRuleRefs: 1,
      operationRows: 2,
    });

    const grooming = report.renames.find((r) => r.from === 'Grooming')!;
    expect(grooming).toMatchObject({
      merge: true, // Beauty already exists
      categoryRows: 1,
      bankMapRefs: 1,
      merchantRuleRefs: 1,
      operationRows: 1,
    });

    expect(JSON.stringify(tabs)).toBe(before); // dry run
  });

  it('rejects chained renames and duplicate sources', async () => {
    const { api } = makeFake(fixture());
    await expect(
      previewCategoryMigration(api, [
        { from: 'Salary', to: 'Wages' },
        { from: 'Food', to: 'Salary' },
      ]),
    ).rejects.toThrow(/[Cc]hained/);
    await expect(
      previewCategoryMigration(api, [
        { from: 'Salary', to: 'Wages' },
        { from: 'Salary', to: 'Pay' },
      ]),
    ).rejects.toThrow(/[Dd]uplicate/);
  });
});

describe('applyCategoryMigration', () => {
  it('renames in place across all five places, including operations', async () => {
    const { api, tabs } = makeFake(fixture());

    await applyCategoryMigration(api, [{ from: 'Salary', to: 'Wages' }]);

    expect(tabs.categories![1]![0]).toBe('Wages'); // name renamed in place
    expect(tabs.categories![5]![1]).toBe('Wages'); // parent ref repointed
    expect(tabs.bank_category_map![1]![1]).toBe('Wages');
    expect(tabs.merchant_rules![2]![1]).toBe('Wages');
    expect(tabs.counterparty_rules![1]![3]).toBe('Wages');
    expect(tabs.operations![1]![5]).toBe('Wages');
    expect(tabs.operations![4]![5]).toBe('Wages');
    expect(tabs.operations![1]![18]).not.toBe('2026-01-01T00:00:00.000Z'); // updatedAt bumped
    expect(tabs.operations![3]![5]).toBe('Food'); // untouched row stays
  });

  it('merging clears the source categories row and repoints references', async () => {
    const { api, tabs } = makeFake(fixture());

    await applyCategoryMigration(api, [{ from: 'Grooming', to: 'Beauty' }]);

    expect(tabs.categories![3]![0]).toBe(''); // source row blanked
    expect(tabs.categories![3]![1]).toBe('');
    expect(tabs.categories![2]![0]).toBe('Beauty'); // target row untouched
    expect(tabs.bank_category_map![2]![1]).toBe('Beauty');
    expect(tabs.operations![2]![5]).toBe('Beauty');
  });

  it('two sources merging into one new name create it once', async () => {
    const { api, tabs } = makeFake(fixture());

    await applyCategoryMigration(api, [
      { from: 'Grooming', to: 'Care' },
      { from: 'Beauty', to: 'Care' },
    ]);

    const names = tabs.categories!.slice(1).map((r) => r[0]);
    expect(names.filter((n) => n === 'Care')).toHaveLength(1);
  });

  it('aborts the operations write when the tab changed underneath', async () => {
    const base = fixture();
    const { api, tabs } = makeFake(base);

    // Sabotage: the second read of the category column sees different data.
    let reads = 0;
    const realGet = api.getValues.bind(api);
    api.getValues = async (range: string) => {
      if (range.startsWith('operations!F2')) {
        reads++;
        if (reads === 2) {
          tabs.operations!.push(opRow('Salary')); // row appended mid-flight
        }
      }
      return realGet(range);
    };

    await expect(
      applyCategoryMigration(api, [{ from: 'Salary', to: 'Wages' }]),
    ).rejects.toThrow(/changed while/);
    // Operations were not touched with stale indices.
    expect(tabs.operations![1]![5]).toBe('Salary');
  });
});
