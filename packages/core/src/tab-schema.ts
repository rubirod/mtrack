/**
 * Guards against a reserved config tab name colliding with a tab the user
 * built for something else.
 *
 * Every config tab (`balances`, `accounts`, …) has a fixed column layout.
 * The destructive writers — `rewriteTab` (clear + rewrite) and the backup
 * importer's `mergeByKey` (append) — assume the tab they target is ours. If
 * the user happens to have a tab with the same name but a different shape
 * (e.g. a hand-built `balances` dashboard), those writers would clobber or
 * pollute it. `assertWritableTab` reads the header first and refuses when it
 * doesn't match, turning silent data loss into a clear, recoverable error.
 */

import type { SheetsAPI } from './sheets-api';

/** Row 1 of a tab as trimmed strings; `[]` if the tab is missing or empty. */
export async function readHeaderRow(api: SheetsAPI, tab: string): Promise<string[]> {
  let rows: string[][] = [];
  try {
    rows = await api.getValues(`${tab}!1:1`);
  } catch {
    return [];
  }
  return (rows[0] ?? []).map((c) => String(c ?? '').trim());
}

/**
 * A tab is ours to write when it's empty/new, or its header begins with
 * `expected`. Extra trailing columns are allowed — the user may have added
 * their own notes beside the managed columns — but the managed columns must
 * line up. A divergence there means a same-named tab that isn't ours.
 */
export function headerMatches(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length === 0) return true;
  return expected.every((h, i) => actual[i] === h);
}

/**
 * Throws when `tab` exists with a header incompatible with `expected`, so a
 * destructive write bails out instead of overwriting the user's data.
 */
export async function assertWritableTab(
  api: SheetsAPI,
  tab: string,
  expected: readonly string[],
): Promise<void> {
  const actual = await readHeaderRow(api, tab);
  if (!headerMatches(actual, expected)) {
    throw new Error(
      `Tab "${tab}" doesn't match the expected layout [${expected.join(' | ')}]; ` +
        `found [${actual.join(' | ')}]. Refusing to write so your data isn't overwritten — ` +
        `rename that tab (or fix its header row) and retry.`,
    );
  }
}
