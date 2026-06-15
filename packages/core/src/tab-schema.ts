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
 * A tab is ours to write unless a header cell positively contradicts the
 * expected layout. Empty/new tabs pass; blank or missing header cells pass
 * (a hand-made config tab may label only some columns, e.g. `name` without
 * `parent`); extra trailing columns pass (the user's own notes). Only a
 * non-blank managed cell that differs — like a `balances` dashboard whose
 * first column is `accountName` — marks the tab as someone else's.
 */
export function headerMatches(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length === 0) return true;
  return expected.every((h, i) => {
    const cell = actual[i] ?? '';
    return cell === '' || cell === h;
  });
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
