/**
 * Idempotent upsert of classified operations into the spreadsheet.
 *
 * Identity. Each operation gets a stable `id` = SHA-1 hex prefix of
 * (occurredAt, amount, description, account, sourceChannel). Re-importing
 * an overlapping statement updates existing rows instead of duplicating.
 *
 * Manual edits. Column `manualOverride` stores a comma-separated list of
 * fields the user has pinned; the store never overwrites those on
 * subsequent imports. So a user fixes a category in the sheet from their
 * phone and the next import preserves it.
 *
 * Account labels. The `accounts` tab maps (sourceChannel, tail) →
 * (accountName, …). The store reads it on each push and fills in the
 * `accountName` column. So the sheet shows "Main account" instead of
 * "*1234".
 *
 * The store never deletes rows. It only appends new ones and updates the
 * unprotected fields of existing ones.
 */

import type { ClassifiedOperation, Operation } from './types';
import type { ClassifyConfig } from './categories';
import { classify } from './classify';
import type { Cell, Row, SheetsAPI, ValueRange } from './sheets-api';

export type SourceChannel = 'csv' | 'pdf' | 'manual';

const TAB = 'operations';
const ACCOUNTS_TAB = 'accounts';

const HEADERS = [
  'id',
  'occurredAt',
  'account',
  'accountName',
  'kind',
  'category',
  'counterparty',
  'amount',
  'currency',
  'description',
  'bankCategory',
  'mcc',
  'source',
  'needsConfirmation',
  'excluded',
  'manualOverride',
  'sourceChannel',
  'createdAt',
  'updatedAt',
] as const;

type Header = (typeof HEADERS)[number];

const OVERRIDABLE: ReadonlySet<Header> = new Set<Header>([
  'kind',
  'category',
  'counterparty',
  'description',
  'bankCategory',
  'mcc',
  'source',
  'needsConfirmation',
  'excluded',
  'accountName',
]);

function colLetter(idx1based: number): string {
  if (idx1based < 1 || idx1based > 26) throw new Error(`columns > 26 not supported: ${idx1based}`);
  return String.fromCharCode('A'.charCodeAt(0) + idx1based - 1);
}
const LAST_COL = colLetter(HEADERS.length);
const RANGE_DATA = `${TAB}!A2:${LAST_COL}`;
const RANGE_FULL = `${TAB}!A:${LAST_COL}`;

/**
 * Naive ISO timestamp (no offset): "YYYY-MM-DDTHH:MM:SS". Statements don't
 * include a timezone; the user is responsible for interpreting wall-clock
 * times in whatever timezone the bank displays them.
 */
function buildOccurredAt(op: ClassifiedOperation): string {
  const [dd, mm, yyyy] = op.date.split('.');
  const time = op.time ?? '00:00:00';
  return `${yyyy}-${mm}-${dd}T${time}`;
}

/**
 * SHA-1 hex, truncated to 16 chars. Uses Web Crypto, which is available in
 * browsers and in Node 19+. SHA-1 isn't chosen for cryptographic strength,
 * only for deterministic stable identifiers: the same operation must hash
 * to the same id across runs.
 */
async function sha1Hex16(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest('SHA-1', data);
  const hex: string[] = [];
  for (const b of new Uint8Array(buf)) hex.push(b.toString(16).padStart(2, '0'));
  return hex.join('').slice(0, 16);
}

export async function operationId(
  op: ClassifiedOperation,
  sourceChannel: SourceChannel,
): Promise<string> {
  const base = [
    buildOccurredAt(op),
    op.amount.toFixed(2),
    op.description,
    op.account ?? '',
    sourceChannel,
  ].join('|');
  // Append sourceId only when set, so CSV imports (no sourceId) keep their
  // legacy id space and don't get re-hashed on upgrade.
  const key = op.sourceId ? `${base}|${op.sourceId}` : base;
  return sha1Hex16(key);
}

async function ensureOperationsTab(api: SheetsAPI): Promise<void> {
  const tabs = await api.listTabs();
  if (!tabs.includes(TAB)) await api.ensureTab(TAB);

  const head = await api.getValues(`${TAB}!1:1`);
  const current = head[0] ?? [];
  const headersOk =
    current.length >= HEADERS.length && HEADERS.every((h, i) => current[i] === h);

  if (!headersOk) {
    await api.updateValues(`${TAB}!A1`, [HEADERS as unknown as Row]);
  }
}

function strCell(v: string | null | undefined): string {
  return v ?? '';
}

type AccountMap = Map<string, string>;

function accountKey(sourceChannel: SourceChannel, tail: string): string {
  return `${sourceChannel}|${tail}`;
}

/**
 * `accounts` tab — instrument→balance routing:
 *   sourceChannel | tail | balance
 *
 * Maps a physical instrument (a bank card tail, or empty tail = the channel
 * default for card-less rows like interest/cashback) to a canonical balance
 * name from the `balances` tab. Many tails may map to one balance (e.g. two
 * cards of the same account). An empty tail is the fallback for that channel.
 *
 * Balances without any instrument (cash, long-term savings, brokerage) have
 * no row here — they are fed by transfers (counterparty) or manual entry,
 * and live in the `balances` tab only.
 *
 * Column C historically held `accountName`; it's the same position and
 * meaning as `balance`, so older sheets keep working.
 */
async function loadAccounts(api: SheetsAPI): Promise<AccountMap> {
  const map: AccountMap = new Map();
  let rows: string[][] = [];
  try {
    rows = await api.getValues(`${ACCOUNTS_TAB}!A2:C`);
  } catch {
    return map;
  }
  for (const row of rows) {
    const [sourceChannel, tail, balance] = row;
    if (!sourceChannel || !balance) continue;
    map.set(accountKey(sourceChannel as SourceChannel, tail ?? ''), balance);
  }
  return map;
}

function resolveAccountName(
  op: ClassifiedOperation,
  sourceChannel: SourceChannel,
  accounts: AccountMap,
): string {
  // Exact instrument match first, then the channel default (empty tail).
  return (
    accounts.get(accountKey(sourceChannel, op.account ?? '')) ??
    accounts.get(accountKey(sourceChannel, '')) ??
    ''
  );
}

function buildRow(
  op: ClassifiedOperation,
  id: string,
  sourceChannel: SourceChannel,
  accountName: string,
  createdAt: string,
  updatedAt: string,
): Row {
  return [
    id,
    buildOccurredAt(op),
    strCell(op.account),
    accountName,
    op.kind,
    strCell(op.category),
    strCell(op.counterparty),
    op.amount,
    op.currency,
    op.description,
    op.bankCategory,
    strCell(op.mcc),
    op.source,
    op.needsConfirmation,
    op.excluded,
    '',
    sourceChannel,
    createdAt,
    updatedAt,
  ];
}

function parseOverride(cell: string | undefined): Set<string> {
  if (!cell) return new Set();
  return new Set(
    cell
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function mergeRow(existing: Row, fresh: Row): Row {
  const overrideIdx = HEADERS.indexOf('manualOverride');
  const createdAtIdx = HEADERS.indexOf('createdAt');
  const updatedAtIdx = HEADERS.indexOf('updatedAt');
  const protectedFields = parseOverride(existing[overrideIdx] as string | undefined);

  return HEADERS.map((h, i): string | number | boolean | null => {
    if (h === 'manualOverride') return existing[overrideIdx] ?? '';
    if (h === 'createdAt') return existing[createdAtIdx] ?? fresh[i] ?? '';
    if (h === 'updatedAt') return existing[updatedAtIdx] ?? fresh[i] ?? '';
    if (OVERRIDABLE.has(h) && protectedFields.has(h)) return existing[i] ?? fresh[i] ?? '';
    return fresh[i] ?? '';
  });
}

/**
 * Columns written as JS numbers/booleans. We send these to Sheets with
 * `valueInputOption: RAW`, so they're stored as a real number / boolean, but
 * the API reads them back as locale-formatted strings ("TRUE", "-1 234,56").
 * Comparing those raw forms with String() flags every row as changed, so a
 * re-import (or `reclassifyAll`) rewrites the whole sheet and never reports
 * `unchanged`. Normalize the two non-string columns before comparing.
 */
const NUMERIC_COLS: ReadonlySet<Header> = new Set<Header>(['amount']);
const BOOLEAN_COLS: ReadonlySet<Header> = new Set<Header>(['needsConfirmation', 'excluded']);

function canonicalBool(s: string): string {
  const l = s.trim().toLowerCase();
  if (l === 'true') return 'TRUE';
  if (l === '' || l === 'false') return 'FALSE';
  return l;
}

/** Space/comma-tolerant parse so "-1 234,56" and "-1234.56" compare equal. */
function parseLooseNumber(s: string): number {
  return parseFloat(s.replace(/\s/g, '').replace(',', '.'));
}

/** Cell equality that survives a Google Sheets RAW-write / formatted-read round-trip. */
function cellsEqual(header: Header | undefined, a: Cell | undefined, b: Cell | undefined): boolean {
  const sa = String(a ?? '').trim();
  const sb = String(b ?? '').trim();
  if (header && BOOLEAN_COLS.has(header)) return canonicalBool(sa) === canonicalBool(sb);
  if (header && NUMERIC_COLS.has(header)) {
    const na = parseLooseNumber(sa);
    const nb = parseLooseNumber(sb);
    if (Number.isFinite(na) && Number.isFinite(nb)) return Math.abs(na - nb) < 1e-9;
  }
  return sa === sb;
}

function rowsEqual(a: Row, b: Row): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!cellsEqual(HEADERS[i], a[i], b[i])) return false;
  }
  return true;
}

function padRow(row: Row): Row {
  const padded = [...row];
  while (padded.length < HEADERS.length) padded.push('');
  return padded;
}

export interface PushResult {
  appended: number;
  updated: number;
  unchanged: number;
}

/** Idempotently upserts classified operations into the spreadsheet. */
export async function pushOperations(
  api: SheetsAPI,
  ops: ClassifiedOperation[],
  sourceChannel: SourceChannel,
): Promise<PushResult> {
  await ensureOperationsTab(api);
  const accounts = await loadAccounts(api);

  const idCol = HEADERS.indexOf('id');
  const existingRaw = await api.getValues(RANGE_DATA);
  const existingRows: Row[] = existingRaw as Row[];
  const indexById = new Map<string, number>();
  existingRows.forEach((row, idx) => {
    const id = row[idCol] as string | undefined;
    if (id) indexById.set(id, idx);
  });

  const now = new Date().toISOString();
  const toAppend: Row[] = [];
  const toUpdate: Array<{ rowNum: number; row: Row }> = [];
  let unchanged = 0;

  for (const op of ops) {
    const id = await operationId(op, sourceChannel);
    const accountName = resolveAccountName(op, sourceChannel, accounts);
    const fresh = buildRow(op, id, sourceChannel, accountName, now, now);
    const existingIdx = indexById.get(id);

    if (existingIdx === undefined) {
      toAppend.push(fresh);
      continue;
    }

    const existingRow = padRow(existingRows[existingIdx] ?? []);
    const merged = mergeRow(existingRow, fresh);
    if (rowsEqual(existingRow, merged)) {
      unchanged++;
      continue;
    }
    const updatedAtIdx = HEADERS.indexOf('updatedAt');
    merged[updatedAtIdx] = now;
    toUpdate.push({ rowNum: existingIdx + 2, row: merged });
  }

  if (toAppend.length > 0) {
    await api.appendValues(RANGE_FULL, toAppend);
  }

  if (toUpdate.length > 0) {
    const data: ValueRange[] = toUpdate.map(({ rowNum, row }) => ({
      range: `${TAB}!A${rowNum}:${LAST_COL}${rowNum}`,
      values: [row],
    }));
    await api.batchUpdateValues(data);
  }

  return { appended: toAppend.length, updated: toUpdate.length, unchanged };
}

/**
 * Re-runs classification and account-name resolution over all rows in the
 * `operations` tab using the current rules. No source file involved — the
 * existing rows are the input. Same merge semantics as `pushOperations`:
 * `manualOverride` is honoured, `createdAt` preserved, `updatedAt` bumped
 * only when something actually changes.
 *
 * Use this after editing rules in the spreadsheet (or via the Rules tab in
 * the PWA) to backfill new mappings into existing rows.
 */
export async function reclassifyAll(
  api: SheetsAPI,
  config: ClassifyConfig,
): Promise<PushResult> {
  await ensureOperationsTab(api);
  const accounts = await loadAccounts(api);

  const existingRaw = await api.getValues(RANGE_DATA);
  const existingRows: Row[] = existingRaw as Row[];

  const dateCol = HEADERS.indexOf('occurredAt');
  const accountCol = HEADERS.indexOf('account');
  const amountCol = HEADERS.indexOf('amount');
  const currencyCol = HEADERS.indexOf('currency');
  const descCol = HEADERS.indexOf('description');
  const bankCatCol = HEADERS.indexOf('bankCategory');
  const mccCol = HEADERS.indexOf('mcc');
  const idCol = HEADERS.indexOf('id');
  const sourceChannelCol = HEADERS.indexOf('sourceChannel');
  const createdAtCol = HEADERS.indexOf('createdAt');
  const updatedAtCol = HEADERS.indexOf('updatedAt');

  const now = new Date().toISOString();
  const toUpdate: Array<{ rowNum: number; row: Row }> = [];
  let unchanged = 0;

  existingRows.forEach((rawRow, idx) => {
    const existingRow = padRow(rawRow);
    const id = String(existingRow[idCol] ?? '');
    if (!id) return;

    const occurredAt = String(existingRow[dateCol] ?? '');
    const [datePart, timePart] = occurredAt.split('T');
    const [yyyy, mm, dd] = (datePart ?? '').split('-');
    const date = yyyy && mm && dd ? `${dd}.${mm}.${yyyy}` : '';
    const time = timePart ? timePart.split(/[+-Z]/)[0]! : null;

    const op: Operation = {
      date,
      time,
      account: String(existingRow[accountCol] ?? '') || null,
      amount: Number(existingRow[amountCol] ?? 0),
      currency: String(existingRow[currencyCol] ?? ''),
      bankCategory: String(existingRow[bankCatCol] ?? ''),
      mcc: String(existingRow[mccCol] ?? '') || null,
      description: String(existingRow[descCol] ?? ''),
    };
    const classified = classify(op, config);
    const sourceChannel = (existingRow[sourceChannelCol] as SourceChannel) || 'manual';
    const accountName = resolveAccountName(classified, sourceChannel, accounts);

    const createdAt = String(existingRow[createdAtCol] ?? now);
    const fresh = buildRow(classified, id, sourceChannel, accountName, createdAt, now);
    const merged = mergeRow(existingRow, fresh);

    if (rowsEqual(existingRow, merged)) {
      unchanged++;
      return;
    }
    merged[updatedAtCol] = now;
    toUpdate.push({ rowNum: idx + 2, row: merged });
  });

  if (toUpdate.length > 0) {
    // Sheets caps batchUpdate payload; chunk to keep requests small.
    const CHUNK = 200;
    for (let i = 0; i < toUpdate.length; i += CHUNK) {
      const slice = toUpdate.slice(i, i + CHUNK);
      const data: ValueRange[] = slice.map(({ rowNum, row }) => ({
        range: `${TAB}!A${rowNum}:${LAST_COL}${rowNum}`,
        values: [row],
      }));
      await api.batchUpdateValues(data);
    }
  }

  return { appended: 0, updated: toUpdate.length, unchanged };
}
