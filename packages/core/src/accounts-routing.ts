/**
 * Non-destructive save for the `accounts` instrument→balance routing.
 *
 * The card-routing editor only knows the instruments seen in `operations`, so
 * it's a *partial* view of the tab. Rewriting the whole tab from it would drop
 * routing rows for instruments without recent operations and wipe any extra
 * columns the user keeps alongside the managed ones (bank, type, currency, …).
 * Instead we match each entry to an existing row by (sourceChannel, tail) and
 * update only the balance column, append genuinely new instruments, and leave
 * every other row and column untouched.
 */

import type { Row, SheetsAPI, ValueRange } from './sheets-api';

const TAB = 'accounts';
const HEADERS = ['sourceChannel', 'tail', 'balance'];
// A=sourceChannel, B=tail, C=balance — the only column this save owns.
const BALANCE_COL = 'C';

export interface RoutingEntry {
  sourceChannel: string;
  tail: string;
  balance: string;
}

function key(sourceChannel: string, tail: string): string {
  return `${sourceChannel}|${tail}`;
}

export interface RoutingSaveResult {
  updated: number;
  appended: number;
}

export async function upsertAccountRouting(
  api: SheetsAPI,
  entries: RoutingEntry[],
): Promise<RoutingSaveResult> {
  const tabs = await api.listTabs();
  if (!tabs.includes(TAB)) {
    await api.ensureTab(TAB);
    await api.updateValues(`${TAB}!A1`, [HEADERS as unknown as Row]);
  }

  // Only the key columns are needed to locate rows; row N in this range is
  // sheet row N+2 (header is row 1).
  const keyRows = await api.getValues(`${TAB}!A2:B`);
  const rowByKey = new Map<string, number>();
  keyRows.forEach((row, i) => {
    const sourceChannel = row[0];
    if (sourceChannel) rowByKey.set(key(sourceChannel, row[1] ?? ''), i + 2);
  });

  const updates: ValueRange[] = [];
  const appends: Row[] = [];
  for (const e of entries) {
    const rowNum = rowByKey.get(key(e.sourceChannel, e.tail));
    if (rowNum !== undefined) {
      // Touch only the balance cell, preserving any columns the user added.
      updates.push({ range: `${TAB}!${BALANCE_COL}${rowNum}`, values: [[e.balance]] });
    } else if (e.balance) {
      appends.push([e.sourceChannel, e.tail, e.balance]);
    }
  }

  if (updates.length > 0) await api.batchUpdateValues(updates);
  if (appends.length > 0) await api.appendValues(`${TAB}!A:C`, appends);
  return { updated: updates.length, appended: appends.length };
}
