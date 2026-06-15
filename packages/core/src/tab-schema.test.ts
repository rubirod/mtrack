import { describe, expect, it } from 'vitest';
import { assertWritableTab, headerMatches, readHeaderRow } from './tab-schema';
import type { Row, SheetsAPI, ValueRange } from './sheets-api';

const BALANCES = ['name', 'currency', 'type', 'archived'];

/** SheetsAPI stub whose `getValues` returns a fixed header for `<tab>!1:1`. */
function apiWithHeader(header: string[] | null): SheetsAPI {
  return {
    async getValues(range: string): Promise<string[][]> {
      if (header === null) throw new Error('missing tab');
      return range.endsWith('!1:1') ? [header] : [];
    },
    async updateValues(): Promise<void> {},
    async appendValues(): Promise<void> {},
    async batchUpdateValues(_data: ValueRange[]): Promise<void> {},
    async listTabs(): Promise<string[]> {
      return [];
    },
    async ensureTab(): Promise<void> {},
    async clearRange(): Promise<void> {},
  } as SheetsAPI;
}

describe('headerMatches', () => {
  it('treats an empty header as a new tab (writable)', () => {
    expect(headerMatches([], BALANCES)).toBe(true);
  });

  it('accepts an exact match', () => {
    expect(headerMatches([...BALANCES], BALANCES)).toBe(true);
  });

  it('accepts extra trailing columns the user added', () => {
    expect(headerMatches([...BALANCES, 'note'], BALANCES)).toBe(true);
  });

  it('rejects a divergent managed column', () => {
    expect(headerMatches(['accountName', 'currency', 'net', 'income'], BALANCES)).toBe(false);
  });

  it('rejects a header shorter than expected', () => {
    expect(headerMatches(['name', 'currency'], BALANCES)).toBe(false);
  });
});

describe('readHeaderRow', () => {
  it('returns [] when the tab is missing', async () => {
    expect(await readHeaderRow(apiWithHeader(null), 'balances')).toEqual([]);
  });

  it('trims the header cells', async () => {
    expect(await readHeaderRow(apiWithHeader([' name ', 'currency']), 'balances')).toEqual([
      'name',
      'currency',
    ]);
  });
});

describe('assertWritableTab', () => {
  it('resolves for a matching tab', async () => {
    await expect(assertWritableTab(apiWithHeader(BALANCES), 'balances', BALANCES)).resolves.toBeUndefined();
  });

  it('resolves for an empty/new tab', async () => {
    await expect(assertWritableTab(apiWithHeader([]), 'balances', BALANCES)).resolves.toBeUndefined();
  });

  it('throws for a foreign same-named tab', async () => {
    const foreign = ['accountName', 'currency', 'net', 'income', 'expense', '# ops'];
    await expect(
      assertWritableTab(apiWithHeader(foreign), 'balances', BALANCES),
    ).rejects.toThrow(/doesn't match the expected layout/);
  });
});
