import { describe, expect, it } from 'vitest';
import {
  appendManualOperations,
  applyOperationPatch,
  pushOperations,
  reclassifyAll,
  updateOperationFields,
} from './operations-store';
import type { ClassifiedOperation } from './types';
import type { ClassifyConfig } from './categories';
import type { Cell, Row, SheetsAPI, ValueRange } from './sheets-api';

const EMPTY_CONFIG: ClassifyConfig = {
  bankCategoryMap: new Map(),
  merchantRules: [],
  counterpartyRules: [],
};
const KIND_COL = 4; // id,occurredAt,account,accountName,kind,category,…
const CATEGORY_COL = 5;
const OVERRIDE_COL = 15;

/**
 * Renders a stored cell the way the Sheets API's default FORMATTED_VALUE does:
 * numbers and booleans never come back as JS types, only as locale strings.
 * We deliberately use comma-decimal + NBSP grouping (a non-US locale) so the
 * test exercises the numeric normalization, not just the boolean one.
 */
function render(cell: Cell): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE';
  if (typeof cell === 'number') {
    const neg = cell < 0 ? '-' : '';
    const [int, frac] = Math.abs(cell).toString().split('.');
    const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return frac ? `${neg}${grouped},${frac}` : `${neg}${grouped}`;
  }
  return String(cell);
}

function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseEnd(s: string): { col: number | null; row: number | null } {
  const m = /^([A-Z]*)(\d*)$/.exec(s)!;
  return { col: m[1] ? colIndex(m[1]) : null, row: m[2] ? parseInt(m[2], 10) - 1 : null };
}

/**
 * Minimal in-memory SheetsAPI faithful to the one behaviour under test: it
 * stores raw cell values on write (RAW input) and renders them to strings on
 * read (formatted output). Enough A1 handling for `pushOperations`.
 */
function makeFakeApi(): SheetsAPI {
  const grid = new Map<string, Cell[][]>();

  const ensure = (tab: string): Cell[][] => {
    let g = grid.get(tab);
    if (!g) {
      g = [];
      grid.set(tab, g);
    }
    return g;
  };

  const writeAt = (tab: string, row0: number, col0: number, values: Row[]): void => {
    const g = ensure(tab);
    values.forEach((r, ri) => {
      const target = (g[row0 + ri] ??= []);
      r.forEach((c, ci) => {
        target[col0 + ci] = c;
      });
    });
  };

  return {
    async getValues(range: string): Promise<string[][]> {
      const [tab, ref] = range.split('!');
      const g = grid.get(tab!);
      if (!g) return [];
      const [startRaw, endRaw] = ref!.split(':');
      const start = parseEnd(startRaw!);
      const end = endRaw ? parseEnd(endRaw) : start;
      const r0 = start.row ?? 0;
      const r1 = end.row ?? g.length - 1;
      const c0 = start.col ?? 0;
      const out: string[][] = [];
      for (let r = r0; r <= r1 && r < g.length; r++) {
        const row = g[r] ?? [];
        const c1 = end.col ?? row.length - 1;
        const cells: string[] = [];
        for (let c = c0; c <= c1; c++) cells.push(render(row[c] ?? ''));
        out.push(cells);
      }
      return out;
    },
    async updateValues(range: string, values: Row[]): Promise<void> {
      const [tab, ref] = range.split('!');
      const start = parseEnd(ref!.split(':')[0]!);
      writeAt(tab!, start.row ?? 0, start.col ?? 0, values);
    },
    async appendValues(range: string, values: Row[]): Promise<void> {
      const [tab, ref] = range.split('!');
      const start = parseEnd(ref!.split(':')[0]!);
      const g = ensure(tab!);
      writeAt(tab!, g.length, start.col ?? 0, values);
    },
    async batchUpdateValues(data: ValueRange[]): Promise<void> {
      for (const { range, values } of data) {
        const [tab, ref] = range.split('!');
        const start = parseEnd(ref!.split(':')[0]!);
        writeAt(tab!, start.row ?? 0, start.col ?? 0, values);
      }
    },
    async listTabs(): Promise<string[]> {
      return [...grid.keys()];
    },
    async ensureTab(title: string): Promise<void> {
      ensure(title);
    },
    async clearRange(): Promise<void> {
      /* unused here */
    },
  };
}

function op(over: Partial<ClassifiedOperation> = {}): ClassifiedOperation {
  return {
    date: '14.03.2026',
    time: '12:30:00',
    account: 'Cash',
    amount: -1234.56,
    currency: 'RUB',
    bankCategory: '',
    mcc: null,
    description: 'Coffee',
    kind: 'expense',
    category: 'Food',
    counterparty: null,
    source: 'manual',
    needsConfirmation: false,
    excluded: false,
    sourceId: 'mp:1',
    ...over,
  };
}

describe('pushOperations round-trip idempotency', () => {
  const ops = (): ClassifiedOperation[] => [
    op(),
    op({ sourceId: 'mp:2', amount: 50000, description: 'Salary', kind: 'income', needsConfirmation: true }),
  ];

  it('reports unchanged (not updated) when re-pushing identical operations', async () => {
    const api = makeFakeApi();
    const first = await pushOperations(api, ops(), 'manual');
    expect(first).toEqual({ appended: 2, updated: 0, unchanged: 0 });

    // The regression: before normalizing the boolean/number round-trip this
    // came back as { appended: 0, updated: 2, unchanged: 0 }.
    const second = await pushOperations(api, ops(), 'manual');
    expect(second).toEqual({ appended: 0, updated: 0, unchanged: 2 });
  });

  it('still detects a genuine change to an overridable field', async () => {
    const api = makeFakeApi();
    await pushOperations(api, ops(), 'manual');

    const changed = ops();
    changed[0] = op({ needsConfirmation: true }); // false -> true, same id
    const result = await pushOperations(api, changed, 'manual');
    expect(result).toEqual({ appended: 0, updated: 1, unchanged: 1 });
  });
});

describe('reclassifyAll non-destructive mode', () => {
  // A curated row a rule can't reproduce: 'Food' category, blank bankCategory,
  // a description no rule matches. Mirrors a Money Pro master operation.
  const curated = (): ClassifiedOperation => op({ category: 'Food', description: 'Coffee' });

  it('keeps a curated category when no rule matches (preserveNonEmpty)', async () => {
    const api = makeFakeApi();
    await pushOperations(api, [curated()], 'manual');

    const res = await reclassifyAll(api, EMPTY_CONFIG, { preserveNonEmpty: true });
    expect(res.preserved).toBe(1);

    const rows = await api.getValues('operations!A2:S');
    expect(rows[0]![CATEGORY_COL]).toBe('Food');
  });

  it('blanks the category without the guard (destructive default)', async () => {
    const api = makeFakeApi();
    await pushOperations(api, [curated()], 'manual');

    const res = await reclassifyAll(api, EMPTY_CONFIG);
    expect(res.updated).toBe(1);
    expect(res.preserved).toBe(0);

    const rows = await api.getValues('operations!A2:S');
    expect(rows[0]![CATEGORY_COL]).toBe('');
  });

  it('dryRun reports the change but writes nothing', async () => {
    const api = makeFakeApi();
    await pushOperations(api, [curated()], 'manual');

    const res = await reclassifyAll(api, EMPTY_CONFIG, { dryRun: true });
    expect(res.updated).toBe(1);

    const rows = await api.getValues('operations!A2:S');
    expect(rows[0]![CATEGORY_COL]).toBe('Food'); // untouched on disk
  });

  it('a matching merchant rule still overwrites the old category', async () => {
    const api = makeFakeApi();
    await pushOperations(api, [curated()], 'manual');

    const config: ClassifyConfig = {
      bankCategoryMap: new Map(),
      merchantRules: [{ match: 'coffee', category: 'Eating out' }],
      counterpartyRules: [],
    };
    const res = await reclassifyAll(api, config, { preserveNonEmpty: true });
    expect(res.updated).toBe(1);

    const rows = await api.getValues('operations!A2:S');
    expect(rows[0]![CATEGORY_COL]).toBe('Eating out');
  });

  it('keeps a curated kind when no counterparty rule matches (preserveNonEmpty)', async () => {
    // A Money Pro transfer: kind is curated data, and its blank bankCategory /
    // unmatched description give the rules nothing to rediscover it from. The
    // expense fallback must not downgrade it.
    const api = makeFakeApi();
    await pushOperations(api, [op({ kind: 'transfer', category: null, counterparty: 'Podushka' })], 'manual');

    const res = await reclassifyAll(api, EMPTY_CONFIG, { preserveNonEmpty: true });
    expect(res.preserved).toBe(1);

    const rows = await api.getValues('operations!A2:S');
    expect(rows[0]![KIND_COL]).toBe('transfer');
  });

  it('a matching counterparty rule still overwrites the old kind', async () => {
    const api = makeFakeApi();
    await pushOperations(api, [op({ kind: 'transfer', category: null, counterparty: 'Podushka' })], 'manual');

    const config: ClassifyConfig = {
      bankCategoryMap: new Map(),
      merchantRules: [],
      counterpartyRules: [{ match: 'coffee', kind: 'peer', label: 'Buddy' }],
    };
    await reclassifyAll(api, config, { preserveNonEmpty: true });

    const rows = await api.getValues('operations!A2:S');
    expect(rows[0]![KIND_COL]).toBe('peer');
  });
});

describe('appendManualOperations fast path', () => {
  it('appends each op with the picked balance and distinct ids', async () => {
    const api = makeFakeApi();
    const ops = [
      op({ sourceId: 'receipt:1:0', category: 'Food', description: 'Bread', source: 'ai' }),
      op({ sourceId: 'receipt:1:1', category: 'Drinks', description: 'Juice', source: 'ai' }),
    ];
    const n = await appendManualOperations(api, ops, 'IDR Cash', 'receipt');
    expect(n).toBe(2);

    const rows = await api.getValues('operations!A1:S');
    const ACCOUNT_NAME = 3;
    const SOURCE = 12;
    const SOURCE_CHANNEL = 16;
    expect(rows).toHaveLength(2);
    expect(rows[0]![ACCOUNT_NAME]).toBe('IDR Cash');
    expect(rows[0]![SOURCE]).toBe('ai');
    expect(rows[0]![SOURCE_CHANNEL]).toBe('receipt');
    expect(rows[0]![0]).not.toBe(rows[1]![0]); // distinct ids from distinct sourceIds
  });
});

describe('updateOperationFields single-op fast path', () => {
  it('patches one row by id and pins manualOverride', async () => {
    const api = makeFakeApi();
    await pushOperations(api, [op({ category: '', description: 'X' })], 'manual');
    const id = (await api.getValues('operations!A2:A'))[0]![0]!;

    const ok = await updateOperationFields(api, id, { category: 'Food' }, { pin: ['category'] });
    expect(ok).toBe(true);

    const rows = await api.getValues('operations!A2:S');
    expect(rows[0]![CATEGORY_COL]).toBe('Food');
    expect(rows[0]![OVERRIDE_COL]).toContain('category');
  });

  it('returns false for an unknown id', async () => {
    const api = makeFakeApi();
    await pushOperations(api, [op()], 'manual');
    expect(await updateOperationFields(api, 'no-such-id', { category: 'X' })).toBe(false);
  });

  it('applyOperationPatch is pure and merges manualOverride', () => {
    const row = ['id1', '', '', '', 'expense', 'Old', '', -1, 'RUB', 'X', '', '', 'rule', false, false, 'kind', 'csv', '', ''];
    const out = applyOperationPatch(row, { category: 'New' }, ['category']);
    expect(out[CATEGORY_COL]).toBe('New');
    expect(out[OVERRIDE_COL]).toBe('kind,category');
    expect(row[CATEGORY_COL]).toBe('Old'); // input untouched
  });
});
