/**
 * Moving operations off a category, without touching the tree.
 *
 * The sibling migration (`category-migration.ts`) implements a different
 * verb: "this name ceases to exist, replace it everywhere" — so it also
 * rewrites the `parent` column, which is exactly right for a rename (children
 * must follow their parent or they end up orphaned) and exactly wrong here.
 * Merging «Транспорт» into its own child «Общественный транспорт» would clear
 * the parent row, re-nest all eight children under the child, and leave that
 * child pointing at itself.
 *
 * What is needed instead is: the category keeps existing — usually because it
 * is a grouping node — but stops holding operations of its own. That means
 * two things and nothing else: repoint every `operations` row carrying it, and
 * repoint the rules that produced it, so a later "Apply now" agrees with the
 * move rather than undoing it. The `categories` tab is never written.
 *
 * The target must be a leaf that already exists. An operation always stores a
 * leaf (the parent is for grouping in reports), so moving rows onto a node
 * that has children would recreate the very inconsistency this tool exists to
 * clean up.
 *
 * No `manualOverride` pinning is applied: the repointed rules keep rule-driven
 * rows on the new category, and rows no rule can match are protected by
 * `reclassifyAll`'s preserveNonEmpty mode, which never blanks a value the
 * recompute couldn't reproduce. Pinning would only freeze them against future
 * rule improvements.
 */

import type { SheetsAPI } from './sheets-api';
import { OPERATION_HEADERS } from './operations-store';
import {
  cleanRenames,
  colLetter,
  findCol,
  planColumn,
  safeRead,
  validateRenames,
  writeChunked,
  type Rename,
  type TabPlan,
} from './migration-utils';

export interface CategoryReassign extends Rename {
  /** Category to empty out. Stays in `categories`, untouched. */
  from: string;
  /** Existing leaf that receives the operations. */
  to: string;
}

export interface ReassignCounts {
  from: string;
  to: string;
  operationRows: number;
  bankMapRefs: number;
  merchantRuleRefs: number;
  counterpartyRuleRefs: number;
}

export interface ReassignReport {
  moves: ReassignCounts[];
  /** Total individual cell writes the reassignment performs (or would perform). */
  cellWrites: number;
}

interface Analysis {
  report: ReassignReport;
  bankMapPlan: TabPlan;
  merchantPlan: TabPlan;
  counterpartyPlan: TabPlan;
  operationsPlan: TabPlan;
  opsCategorySnapshot: string[];
  opsCategoryColLetter: string;
}

/** Names in `categories`, and the subset of them that has children. */
async function readTree(
  api: SheetsAPI,
): Promise<{ names: Set<string>; groups: Set<string> }> {
  const [nameCol, parentCol] = await Promise.all([
    findCol(api, 'categories', 'name', 0),
    findCol(api, 'categories', 'parent', 1),
  ]);
  const rows = await safeRead(api, 'categories!A2:Z');
  const names = new Set<string>();
  const groups = new Set<string>();
  for (const r of rows) {
    const name = (r[nameCol] ?? '').trim();
    const parent = (r[parentCol] ?? '').trim();
    if (name) names.add(name);
    if (parent) groups.add(parent);
  }
  return { names, groups };
}

async function analyze(api: SheetsAPI, moves: CategoryReassign[]): Promise<Analysis> {
  validateRenames(moves, 'Move');
  const cleaned = cleanRenames(moves);
  const byFrom = new Map(cleaned.map((m) => [m.from, m.to]));

  const { names, groups } = await readTree(api);
  for (const m of cleaned) {
    if (!names.has(m.to)) {
      throw new Error(
        `Target "${m.to}" is not in the categories tab — add it there first (a typo?).`,
      );
    }
    if (groups.has(m.to)) {
      throw new Error(
        `Target "${m.to}" has child categories, so it groups them rather than holding ` +
          'operations. Pick one of its leaves instead.',
      );
    }
  }

  const [bankMapCatCol, merchantCatCol, cpCatCol] = await Promise.all([
    findCol(api, 'bank_category_map', 'category', 1),
    findCol(api, 'merchant_rules', 'category', 1),
    findCol(api, 'counterparty_rules', 'category', 3),
  ]);
  const opsCategoryCol = OPERATION_HEADERS.indexOf('category');
  const opsUpdatedAtCol = OPERATION_HEADERS.indexOf('updatedAt');

  const [bankRows, merchantRows, cpRows, opsCatColRows] = await Promise.all([
    safeRead(api, 'bank_category_map!A2:Z'),
    safeRead(api, 'merchant_rules!A2:Z'),
    safeRead(api, 'counterparty_rules!A2:Z'),
    safeRead(api, `operations!${colLetter(opsCategoryCol)}2:${colLetter(opsCategoryCol)}`),
  ]);

  const counts = new Map<string, ReassignCounts>();
  for (const m of cleaned) {
    counts.set(m.from, {
      from: m.from,
      to: m.to,
      operationRows: 0,
      bankMapRefs: 0,
      merchantRuleRefs: 0,
      counterpartyRuleRefs: 0,
    });
  }

  const bankMapPlan: TabPlan = { updates: [] };
  const merchantPlan: TabPlan = { updates: [] };
  const counterpartyPlan: TabPlan = { updates: [] };
  const operationsPlan: TabPlan = { updates: [] };

  planColumn(bankRows, bankMapCatCol, 'bank_category_map', byFrom, bankMapPlan, (from) => {
    counts.get(from)!.bankMapRefs++;
  });
  planColumn(merchantRows, merchantCatCol, 'merchant_rules', byFrom, merchantPlan, (from) => {
    counts.get(from)!.merchantRuleRefs++;
  });
  planColumn(cpRows, cpCatCol, 'counterparty_rules', byFrom, counterpartyPlan, (from) => {
    counts.get(from)!.counterpartyRuleRefs++;
  });

  const now = new Date().toISOString();
  const opsCategorySnapshot = opsCatColRows.map((r) => String(r[0] ?? ''));
  for (let i = 0; i < opsCategorySnapshot.length; i++) {
    const to = byFrom.get(opsCategorySnapshot[i]!.trim());
    if (to === undefined) continue;
    counts.get(opsCategorySnapshot[i]!.trim())!.operationRows++;
    const sheetRow = i + 2;
    operationsPlan.updates.push(
      { range: `operations!${colLetter(opsCategoryCol)}${sheetRow}`, values: [[to]] },
      { range: `operations!${colLetter(opsUpdatedAtCol)}${sheetRow}`, values: [[now]] },
    );
  }

  const cellWrites =
    bankMapPlan.updates.length +
    merchantPlan.updates.length +
    counterpartyPlan.updates.length +
    operationsPlan.updates.length;

  return {
    report: { moves: [...counts.values()], cellWrites },
    bankMapPlan,
    merchantPlan,
    counterpartyPlan,
    operationsPlan,
    opsCategorySnapshot,
    opsCategoryColLetter: colLetter(opsCategoryCol),
  };
}

/** Dry run: counts what an `applyCategoryReassign` with the same input would touch. */
export async function previewCategoryReassign(
  api: SheetsAPI,
  moves: CategoryReassign[],
): Promise<ReassignReport> {
  return (await analyze(api, moves)).report;
}

/**
 * Performs the move. Re-reads the sheet itself, and re-checks the operations
 * category column immediately before writing — a mismatch means the sheet
 * moved underneath (edit / import / re-sort) and it aborts without writing
 * operations.
 */
export async function applyCategoryReassign(
  api: SheetsAPI,
  moves: CategoryReassign[],
): Promise<ReassignReport> {
  const a = await analyze(api, moves);

  await writeChunked(api, a.bankMapPlan.updates);
  await writeChunked(api, a.merchantPlan.updates);
  await writeChunked(api, a.counterpartyPlan.updates);

  if (a.operationsPlan.updates.length > 0) {
    const col = a.opsCategoryColLetter;
    const recheck = await safeRead(api, `operations!${col}2:${col}`);
    const current = recheck.map((r) => String(r[0] ?? ''));
    const same =
      current.length === a.opsCategorySnapshot.length &&
      current.every((v, i) => v === a.opsCategorySnapshot[i]);
    if (!same) {
      throw new Error(
        'The operations tab changed while the move was being prepared ' +
          '(rows added, edited or re-sorted). Rules are already repointed; ' +
          'operations were NOT touched — run the move again to finish.',
      );
    }
    await writeChunked(api, a.operationsPlan.updates);
  }

  return a.report;
}
