/**
 * Category rename / merge migration.
 *
 * A category name lives in five places at once: the `categories` tab (name
 * and parent columns), `bank_category_map` (column B), `merchant_rules`
 * (column B), `counterparty_rules` (column D), and every affected row of
 * `operations`. Renaming in only some of them corrupts the data in a sneaky
 * way: a later "Apply now" (reclassifyAll) either reverts un-pinned rows to
 * the old name (rules still say `Salary`) or leaves pinned rows stranded on
 * it forever (manualOverride shields them from reclassification).
 *
 * So a rename here is a value migration, not a reclassification: it touches
 * all five places in one pass, *including* rows pinned via `manualOverride`.
 * After a migration, "Apply now" should report ~0 updates caused by the
 * renames — a cheap built-in consistency check.
 *
 * Merging is a rename whose target already exists (`Grooming` → `Beauty`
 * while `Beauty` is already a category): the source row in `categories` is
 * cleared (left as a blank row, compacted later by hand), every reference is
 * repointed.
 *
 * Writes are per-cell `batchUpdateValues` calls — no tab is cleared or
 * rewritten, so user columns and dashboard rows are never collateral damage.
 * Before writing `operations` the category column is read a second time and
 * compared with the first read; if the sheet changed in between (concurrent
 * edit, re-sort), the migration aborts instead of writing to shifted rows.
 */

import type { Row, SheetsAPI, ValueRange } from './sheets-api';
import { OPERATION_HEADERS } from './operations-store';
import { readHeaderRow } from './tab-schema';

export interface CategoryRename {
  /** Existing category name to migrate away from. */
  from: string;
  /** Target name. May be brand new (rename) or existing (merge). */
  to: string;
}

export interface RenameCounts {
  from: string;
  to: string;
  /** true → target already exists; the source `categories` row is cleared. */
  merge: boolean;
  /** `categories` name cells (0 when the source row is missing, 1 normally). */
  categoryRows: number;
  /** `categories` parent cells pointing at `from`. */
  parentRefs: number;
  bankMapRefs: number;
  merchantRuleRefs: number;
  counterpartyRuleRefs: number;
  operationRows: number;
}

export interface MigrationReport {
  renames: RenameCounts[];
  /** Total individual cell writes the migration performs (or would perform). */
  cellWrites: number;
}

const CHUNK = 200;

interface TabPlan {
  /** Cell updates for one tab, already in A1 notation. */
  updates: ValueRange[];
}

interface Analysis {
  report: MigrationReport;
  categoriesPlan: TabPlan;
  bankMapPlan: TabPlan;
  merchantPlan: TabPlan;
  counterpartyPlan: TabPlan;
  operationsPlan: TabPlan;
  /** Snapshot of the operations category column for the pre-write check. */
  opsCategorySnapshot: string[];
  opsCategoryColLetter: string;
  opsUpdatedAtColLetter: string;
}

function colLetter(idx0based: number): string {
  if (idx0based < 0 || idx0based > 25) throw new Error(`column index out of A-Z range: ${idx0based}`);
  return String.fromCharCode('A'.charCodeAt(0) + idx0based);
}

/** Column index by header name, with a canonical fallback for blank headers. */
async function findCol(
  api: SheetsAPI,
  tab: string,
  header: string,
  fallback: number,
): Promise<number> {
  const row = await readHeaderRow(api, tab);
  const idx = row.indexOf(header);
  return idx >= 0 ? idx : fallback;
}

function validateRenames(renames: CategoryRename[]): void {
  const seen = new Set<string>();
  for (const r of renames) {
    const from = r.from.trim();
    const to = r.to.trim();
    if (!from || !to) throw new Error('Both "from" and "to" must be non-empty');
    if (from === to) throw new Error(`Rename "${from}" → same name is a no-op`);
    if (seen.has(from)) throw new Error(`Duplicate rename source "${from}"`);
    seen.add(from);
  }
  // Chains (A→B while B→C is also requested) would make the outcome depend
  // on execution order; refuse them so every rename is a single hop.
  for (const r of renames) {
    if (seen.has(r.to.trim())) {
      throw new Error(
        `Chained rename: "${r.from}" → "${r.to}" while "${r.to}" is itself being renamed`,
      );
    }
  }
}

async function safeRead(api: SheetsAPI, range: string): Promise<string[][]> {
  try {
    return await api.getValues(range);
  } catch {
    return [];
  }
}

async function analyze(api: SheetsAPI, renames: CategoryRename[]): Promise<Analysis> {
  validateRenames(renames);
  const cleaned = renames.map((r) => ({ from: r.from.trim(), to: r.to.trim() }));
  const byFrom = new Map(cleaned.map((r) => [r.from, r.to]));

  const [catNameCol, catParentCol, bankMapCatCol, merchantCatCol, cpCatCol] = await Promise.all([
    findCol(api, 'categories', 'name', 0),
    findCol(api, 'categories', 'parent', 1),
    findCol(api, 'bank_category_map', 'category', 1),
    findCol(api, 'merchant_rules', 'category', 1),
    findCol(api, 'counterparty_rules', 'category', 3),
  ]);
  const opsCategoryCol = OPERATION_HEADERS.indexOf('category');
  const opsUpdatedAtCol = OPERATION_HEADERS.indexOf('updatedAt');

  const catCol = (i: number): string => colLetter(i);

  const [catRows, bankRows, merchantRows, cpRows, opsCatColRows] = await Promise.all([
    safeRead(api, 'categories!A2:Z'),
    safeRead(api, 'bank_category_map!A2:Z'),
    safeRead(api, 'merchant_rules!A2:Z'),
    safeRead(api, 'counterparty_rules!A2:Z'),
    safeRead(api, `operations!${catCol(opsCategoryCol)}2:${catCol(opsCategoryCol)}`),
  ]);

  const existingNames = new Set<string>();
  for (const r of catRows) {
    const name = (r[catNameCol] ?? '').trim();
    if (name) existingNames.add(name);
  }

  // A rename is a merge when its target already exists — either in the
  // sheet, or materialized by an earlier rename in this same batch (two
  // sources merging into one new name: the first creates it, the rest merge).
  const materialized = new Set(existingNames);
  const counts = new Map<string, RenameCounts>();
  for (const r of cleaned) {
    counts.set(r.from, {
      from: r.from,
      to: r.to,
      merge: materialized.has(r.to),
      categoryRows: 0,
      parentRefs: 0,
      bankMapRefs: 0,
      merchantRuleRefs: 0,
      counterpartyRuleRefs: 0,
      operationRows: 0,
    });
    materialized.add(r.to);
  }

  const categoriesPlan: TabPlan = { updates: [] };
  const bankMapPlan: TabPlan = { updates: [] };
  const merchantPlan: TabPlan = { updates: [] };
  const counterpartyPlan: TabPlan = { updates: [] };
  const operationsPlan: TabPlan = { updates: [] };

  // `categories`: rename the name cell in place, or clear the row on merge.
  for (let i = 0; i < catRows.length; i++) {
    const row = catRows[i]!;
    const sheetRow = i + 2;
    const name = (row[catNameCol] ?? '').trim();
    const parent = (row[catParentCol] ?? '').trim();

    const nameTo = byFrom.get(name);
    if (nameTo !== undefined) {
      const c = counts.get(name)!;
      c.categoryRows++;
      if (c.merge) {
        // Merge: the target row already exists elsewhere — blank this one.
        // The row is left as a hole; compacting holes is a separate, purely
        // cosmetic cleanup.
        categoriesPlan.updates.push(
          { range: `categories!${catCol(catNameCol)}${sheetRow}`, values: [['']] },
          { range: `categories!${catCol(catParentCol)}${sheetRow}`, values: [['']] },
        );
        continue; // parent cell cleared with the row; skip the parent check
      }
      categoriesPlan.updates.push({
        range: `categories!${catCol(catNameCol)}${sheetRow}`,
        values: [[nameTo]],
      });
    }

    const parentTo = byFrom.get(parent);
    if (parentTo !== undefined) {
      counts.get(parent)!.parentRefs++;
      categoriesPlan.updates.push({
        range: `categories!${catCol(catParentCol)}${sheetRow}`,
        values: [[parentTo]],
      });
    }
  }

  const planColumn = (
    rows: string[][],
    colIdx: number,
    tab: string,
    plan: TabPlan,
    bump: (c: RenameCounts) => void,
  ): void => {
    for (let i = 0; i < rows.length; i++) {
      const value = (rows[i]![colIdx] ?? '').trim();
      const to = byFrom.get(value);
      if (to === undefined) continue;
      bump(counts.get(value)!);
      plan.updates.push({ range: `${tab}!${colLetter(colIdx)}${i + 2}`, values: [[to]] });
    }
  };

  planColumn(bankRows, bankMapCatCol, 'bank_category_map', bankMapPlan, (c) => c.bankMapRefs++);
  planColumn(merchantRows, merchantCatCol, 'merchant_rules', merchantPlan, (c) => c.merchantRuleRefs++);
  planColumn(cpRows, cpCatCol, 'counterparty_rules', counterpartyPlan, (c) => c.counterpartyRuleRefs++);

  // `operations`: category cell + updatedAt bump, all rows including pinned.
  const now = new Date().toISOString();
  const opsCategorySnapshot: string[] = opsCatColRows.map((r) => String(r[0] ?? ''));
  for (let i = 0; i < opsCategorySnapshot.length; i++) {
    const value = opsCategorySnapshot[i]!.trim();
    const to = byFrom.get(value);
    if (to === undefined) continue;
    counts.get(value)!.operationRows++;
    const sheetRow = i + 2;
    operationsPlan.updates.push({
      range: `operations!${catCol(opsCategoryCol)}${sheetRow}`,
      values: [[to]],
    });
    operationsPlan.updates.push({
      range: `operations!${catCol(opsUpdatedAtCol)}${sheetRow}`,
      values: [[now]],
    });
  }

  const cellWrites =
    categoriesPlan.updates.length +
    bankMapPlan.updates.length +
    merchantPlan.updates.length +
    counterpartyPlan.updates.length +
    operationsPlan.updates.length;

  return {
    report: { renames: [...counts.values()], cellWrites },
    categoriesPlan,
    bankMapPlan,
    merchantPlan,
    counterpartyPlan,
    operationsPlan,
    opsCategorySnapshot,
    opsCategoryColLetter: catCol(opsCategoryCol),
    opsUpdatedAtColLetter: catCol(opsUpdatedAtCol),
  };
}

/** Dry run: counts what an `applyCategoryMigration` with the same input would touch. */
export async function previewCategoryMigration(
  api: SheetsAPI,
  renames: CategoryRename[],
): Promise<MigrationReport> {
  const a = await analyze(api, renames);
  return a.report;
}

async function writeChunked(api: SheetsAPI, updates: ValueRange[]): Promise<void> {
  for (let i = 0; i < updates.length; i += CHUNK) {
    await api.batchUpdateValues(updates.slice(i, i + CHUNK));
  }
}

/**
 * Performs the migration. Re-reads the sheet itself (a stale preview can't
 * poison it) and re-checks the operations category column immediately before
 * writing — a mismatch means the sheet moved underneath (edit / re-sort) and
 * the migration aborts without writing operations.
 */
export async function applyCategoryMigration(
  api: SheetsAPI,
  renames: CategoryRename[],
): Promise<MigrationReport> {
  const a = await analyze(api, renames);

  // Config tabs first: small, and if anything fails here the operations tab
  // hasn't been touched yet.
  await writeChunked(api, a.categoriesPlan.updates);
  await writeChunked(api, a.bankMapPlan.updates);
  await writeChunked(api, a.merchantPlan.updates);
  await writeChunked(api, a.counterpartyPlan.updates);

  if (a.operationsPlan.updates.length > 0) {
    const col = a.opsCategoryColLetter;
    const recheck = await safeRead(api, `operations!${col}2:${col}`);
    const current = recheck.map((r) => String(r[0] ?? ''));
    const sameLength = current.length === a.opsCategorySnapshot.length;
    const sameCells =
      sameLength && current.every((v, i) => v === a.opsCategorySnapshot[i]);
    if (!sameCells) {
      throw new Error(
        'The operations tab changed while the migration was being prepared ' +
          '(rows added, edited or re-sorted). Config tabs are already migrated; ' +
          'operations were NOT touched — run the migration again to finish.',
      );
    }
    await writeChunked(api, a.operationsPlan.updates);
  }

  return a.report;
}
