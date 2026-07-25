/**
 * Balance rename / merge migration.
 *
 * A balance name lives in four places at once: the `balances` tab (column
 * `name`), the `accounts` routing tab (column `balance`), `counterparty_rules`
 * (column `label` — the rule that books an ATM withdrawal as a transfer to
 * "Cash"), and two columns of `operations`: `accountName` (which balance the
 * row belongs to) and `counterparty` (the other leg of a transfer into a
 * logical balance that has no bank instrument).
 *
 * Two balances that mean the same thing — one created by an old backup
 * import, one by later statement imports — therefore can't be merged by
 * editing the `balances` tab alone: the operations keep pointing at both
 * names, and the next "Apply now" re-derives the old name from the routing
 * row that still exists. Like the category migration, this is a value
 * migration: one pass over all four places, including rows pinned via
 * `manualOverride`.
 *
 * Merging (the target name already exists) clears the source row in
 * `balances` — leaving a hole to compact by hand — and repoints every
 * reference. Routing rows are repointed rather than deleted, so the
 * instruments that fed the old balance now feed the surviving one.
 *
 * Writes are per-cell `batchUpdateValues` calls; no tab is cleared or
 * rewritten. Before writing `operations` both migrated columns are read a
 * second time and compared with the first read; a mismatch (concurrent edit,
 * re-sort, import) aborts the migration instead of writing to shifted rows.
 *
 * Not migrated: dashboard formulas that mention a balance name, and the
 * `match` column of `counterparty_rules` (the text a rule looks for in the
 * bank's description, which is bank wording rather than a balance name).
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

export interface BalanceRename extends Rename {
  /** Existing balance name to migrate away from. */
  from: string;
  /** Target name. May be brand new (rename) or existing (merge). */
  to: string;
}

export interface BalanceRenameCounts {
  from: string;
  to: string;
  /** true → target already exists; the source `balances` row is cleared. */
  merge: boolean;
  /** `balances` name cells (0 when the source row is missing, 1 normally). */
  balanceRows: number;
  /** `accounts` rows whose `balance` pointed at `from`. */
  routingRefs: number;
  /** `counterparty_rules` rows whose `label` was `from`. */
  ruleLabelRefs: number;
  /** `operations` rows whose `accountName` was `from`. */
  accountNameRows: number;
  /** `operations` rows whose `counterparty` was `from`. */
  counterpartyRows: number;
}

export interface BalanceMigrationReport {
  renames: BalanceRenameCounts[];
  /** Total individual cell writes the migration performs (or would perform). */
  cellWrites: number;
}

/** The `balances` columns a merge clears, beyond `name`. */
const BALANCE_ROW_COLUMNS = ['name', 'currency', 'type', 'archived'] as const;

interface Analysis {
  report: BalanceMigrationReport;
  balancesPlan: TabPlan;
  accountsPlan: TabPlan;
  rulesPlan: TabPlan;
  operationsPlan: TabPlan;
  /** Snapshot of the two migrated operations columns for the pre-write check. */
  opsSnapshot: string[][];
  opsRange: string;
  /** Offsets of [accountName, counterparty] within a row of `opsRange`. */
  opsOffsets: [number, number];
}

/** Picks the two migrated columns out of a row of the `opsRange` block. */
function opsPair(row: readonly string[], offsets: readonly [number, number]): string[] {
  return [String(row[offsets[0]] ?? ''), String(row[offsets[1]] ?? '')];
}

async function analyze(api: SheetsAPI, renames: BalanceRename[]): Promise<Analysis> {
  validateRenames(renames);
  const cleaned = cleanRenames(renames);
  const byFrom = new Map(cleaned.map((r) => [r.from, r.to]));

  const [balNameCol, routingBalanceCol, ruleLabelCol] = await Promise.all([
    findCol(api, 'balances', 'name', 0),
    findCol(api, 'accounts', 'balance', 2),
    findCol(api, 'counterparty_rules', 'label', 2),
  ]);
  const accountNameCol = OPERATION_HEADERS.indexOf('accountName');
  const counterpartyCol = OPERATION_HEADERS.indexOf('counterparty');
  const updatedAtCol = OPERATION_HEADERS.indexOf('updatedAt');

  // accountName and counterparty are adjacent enough to fetch as one block.
  const opsFirstCol = Math.min(accountNameCol, counterpartyCol);
  const opsLastCol = Math.max(accountNameCol, counterpartyCol);
  const opsRange = `operations!${colLetter(opsFirstCol)}2:${colLetter(opsLastCol)}`;

  const [balRows, accRows, ruleRows, opsRows] = await Promise.all([
    safeRead(api, 'balances!A2:Z'),
    safeRead(api, 'accounts!A2:Z'),
    safeRead(api, 'counterparty_rules!A2:Z'),
    safeRead(api, opsRange),
  ]);

  const existingNames = new Set<string>();
  for (const r of balRows) {
    const name = (r[balNameCol] ?? '').trim();
    if (name) existingNames.add(name);
  }

  // A rename is a merge when its target already exists — either in the sheet,
  // or materialized by an earlier rename in this same batch.
  const materialized = new Set(existingNames);
  const counts = new Map<string, BalanceRenameCounts>();
  for (const r of cleaned) {
    counts.set(r.from, {
      from: r.from,
      to: r.to,
      merge: materialized.has(r.to),
      balanceRows: 0,
      routingRefs: 0,
      ruleLabelRefs: 0,
      accountNameRows: 0,
      counterpartyRows: 0,
    });
    materialized.add(r.to);
  }

  const balancesPlan: TabPlan = { updates: [] };
  const accountsPlan: TabPlan = { updates: [] };
  const rulesPlan: TabPlan = { updates: [] };
  const operationsPlan: TabPlan = { updates: [] };

  // `balances`: rename the name cell in place, or clear the whole row on merge
  // (currency/type/archived belong to the name that's going away).
  for (let i = 0; i < balRows.length; i++) {
    const name = (balRows[i]![balNameCol] ?? '').trim();
    const to = byFrom.get(name);
    if (to === undefined) continue;
    const sheetRow = i + 2;
    const c = counts.get(name)!;
    c.balanceRows++;
    if (c.merge) {
      for (let col = 0; col < BALANCE_ROW_COLUMNS.length; col++) {
        balancesPlan.updates.push({
          range: `balances!${colLetter(col)}${sheetRow}`,
          values: [['']],
        });
      }
      continue;
    }
    balancesPlan.updates.push({
      range: `balances!${colLetter(balNameCol)}${sheetRow}`,
      values: [[to]],
    });
  }

  planColumn(accRows, routingBalanceCol, 'accounts', byFrom, accountsPlan, (from) => {
    counts.get(from)!.routingRefs++;
  });
  planColumn(ruleRows, ruleLabelCol, 'counterparty_rules', byFrom, rulesPlan, (from) => {
    counts.get(from)!.ruleLabelRefs++;
  });

  // `operations`: both name columns, all rows including pinned ones. A row can
  // match in both columns (a transfer between the two merged balances) — it
  // still gets a single `updatedAt` bump.
  const now = new Date().toISOString();
  const opsOffsets: [number, number] = [
    accountNameCol - opsFirstCol,
    counterpartyCol - opsFirstCol,
  ];
  const opsSnapshot = opsRows.map((r) => opsPair(r, opsOffsets));
  for (let i = 0; i < opsSnapshot.length; i++) {
    const sheetRow = i + 2;
    let touched = false;

    const accountName = opsSnapshot[i]![0]!.trim();
    const accountTo = byFrom.get(accountName);
    if (accountTo !== undefined) {
      counts.get(accountName)!.accountNameRows++;
      operationsPlan.updates.push({
        range: `operations!${colLetter(accountNameCol)}${sheetRow}`,
        values: [[accountTo]],
      });
      touched = true;
    }

    const counterparty = opsSnapshot[i]![1]!.trim();
    const counterpartyTo = byFrom.get(counterparty);
    if (counterpartyTo !== undefined) {
      counts.get(counterparty)!.counterpartyRows++;
      operationsPlan.updates.push({
        range: `operations!${colLetter(counterpartyCol)}${sheetRow}`,
        values: [[counterpartyTo]],
      });
      touched = true;
    }

    if (touched) {
      operationsPlan.updates.push({
        range: `operations!${colLetter(updatedAtCol)}${sheetRow}`,
        values: [[now]],
      });
    }
  }

  const cellWrites =
    balancesPlan.updates.length +
    accountsPlan.updates.length +
    rulesPlan.updates.length +
    operationsPlan.updates.length;

  return {
    report: { renames: [...counts.values()], cellWrites },
    balancesPlan,
    accountsPlan,
    rulesPlan,
    operationsPlan,
    opsSnapshot,
    opsRange,
    opsOffsets,
  };
}

/** Dry run: counts what an `applyBalanceMigration` with the same input would touch. */
export async function previewBalanceMigration(
  api: SheetsAPI,
  renames: BalanceRename[],
): Promise<BalanceMigrationReport> {
  const a = await analyze(api, renames);
  return a.report;
}

/**
 * Performs the migration. Re-reads the sheet itself (a stale preview can't
 * poison it) and re-checks the operations name columns immediately before
 * writing — a mismatch means the sheet moved underneath (edit / import /
 * re-sort) and the migration aborts without writing operations.
 */
export async function applyBalanceMigration(
  api: SheetsAPI,
  renames: BalanceRename[],
): Promise<BalanceMigrationReport> {
  const a = await analyze(api, renames);

  // Config tabs first: small, and if anything fails here the operations tab
  // hasn't been touched yet.
  await writeChunked(api, a.balancesPlan.updates);
  await writeChunked(api, a.accountsPlan.updates);
  await writeChunked(api, a.rulesPlan.updates);

  if (a.operationsPlan.updates.length > 0) {
    const recheck = await safeRead(api, a.opsRange);
    const current = recheck.map((r) => opsPair(r, a.opsOffsets));
    const same =
      current.length === a.opsSnapshot.length &&
      current.every(
        (v, i) => v[0] === a.opsSnapshot[i]![0] && v[1] === a.opsSnapshot[i]![1],
      );
    if (!same) {
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
