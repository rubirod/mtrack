/**
 * Shared plumbing for the value migrations (category rename, balance rename).
 *
 * Both migrations do the same thing to a different set of columns: find the
 * column by header, read a tab defensively, validate a batch of rename pairs,
 * and write the resulting per-cell updates in chunks. Only the "where does
 * this name live" map differs, so everything else lives here.
 */

import type { SheetsAPI, ValueRange } from './sheets-api';
import { readHeaderRow } from './tab-schema';

/** One rename pair. `to` may be a new name (rename) or an existing one (merge). */
export interface Rename {
  from: string;
  to: string;
}

/** Cell updates for one tab, already in A1 notation. */
export interface TabPlan {
  updates: ValueRange[];
}

const CHUNK = 200;

export function colLetter(idx0based: number): string {
  if (idx0based < 0 || idx0based > 25) throw new Error(`column index out of A-Z range: ${idx0based}`);
  return String.fromCharCode('A'.charCodeAt(0) + idx0based);
}

/** Reads a range, treating a missing tab as empty rather than an error. */
export async function safeRead(api: SheetsAPI, range: string): Promise<string[][]> {
  try {
    return await api.getValues(range);
  } catch {
    return [];
  }
}

/** Column index by header name, with a canonical fallback for blank headers. */
export async function findCol(
  api: SheetsAPI,
  tab: string,
  header: string,
  fallback: number,
): Promise<number> {
  const row = await readHeaderRow(api, tab);
  const idx = row.indexOf(header);
  return idx >= 0 ? idx : fallback;
}

/**
 * Rejects rename batches whose outcome would depend on execution order:
 * empty names, no-ops, two renames of the same source, and chains (A→B while
 * B→C is also requested). `noun` only shapes the error text.
 */
export function validateRenames(renames: readonly Rename[], noun = 'Rename'): void {
  const seen = new Set<string>();
  for (const r of renames) {
    const from = r.from.trim();
    const to = r.to.trim();
    if (!from || !to) throw new Error('Both "from" and "to" must be non-empty');
    if (from === to) throw new Error(`${noun} "${from}" → same name is a no-op`);
    if (seen.has(from)) throw new Error(`Duplicate rename source "${from}"`);
    seen.add(from);
  }
  for (const r of renames) {
    if (seen.has(r.to.trim())) {
      throw new Error(
        `Chained rename: "${r.from}" → "${r.to}" while "${r.to}" is itself being renamed`,
      );
    }
  }
}

/** Trims both sides of every pair. */
export function cleanRenames(renames: readonly Rename[]): Rename[] {
  return renames.map((r) => ({ from: r.from.trim(), to: r.to.trim() }));
}

/**
 * Plans a single-column rename over already-read rows: for every cell whose
 * trimmed value is a rename source, one cell update. Row `i` of `rows` is
 * sheet row `i + 2` (header is row 1).
 */
export function planColumn(
  rows: readonly string[][],
  colIdx: number,
  tab: string,
  byFrom: ReadonlyMap<string, string>,
  plan: TabPlan,
  bump: (from: string) => void,
): void {
  for (let i = 0; i < rows.length; i++) {
    const value = (rows[i]![colIdx] ?? '').trim();
    const to = byFrom.get(value);
    if (to === undefined) continue;
    bump(value);
    plan.updates.push({ range: `${tab}!${colLetter(colIdx)}${i + 2}`, values: [[to]] });
  }
}

export async function writeChunked(api: SheetsAPI, updates: readonly ValueRange[]): Promise<void> {
  for (let i = 0; i < updates.length; i += CHUNK) {
    await api.batchUpdateValues(updates.slice(i, i + CHUNK));
  }
}
