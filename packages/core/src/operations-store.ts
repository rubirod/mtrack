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

/**
 * Where an operation came from. The three built-ins are suggested, but any
 * string is allowed so the user can namespace per source — e.g. a distinct
 * label per bank CSV, since card tails (the routing key) collide across banks.
 * No bank-specific labels live in code; the user supplies them at import time.
 */
export type SourceChannel = 'csv' | 'pdf' | 'manual' | (string & {});

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

/** The `operations` tab column order, exported so screens can index rows. */
export const OPERATION_HEADERS = HEADERS;

/** Fields a user (or the AI layer) may set on an existing operation row. */
export type EditableField =
  | 'kind'
  | 'category'
  | 'counterparty'
  | 'accountName'
  | 'source'
  | 'needsConfirmation'
  | 'excluded';

export type OperationPatch = Partial<Record<EditableField, Cell>>;

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

export interface ReclassifyOptions {
  /**
   * Never overwrite a non-empty classification field with an empty one. Rules
   * that produce a value still update the row; rules that produce nothing leave
   * the existing value intact. Protects curated categories (e.g. from a Money
   * Pro import) on rows that no current rule matches.
   */
  preserveNonEmpty?: boolean;
  /** Compute the changes but write nothing; the result reports what would happen. */
  dryRun?: boolean;
}

export interface ReclassifyResult extends PushResult {
  /** Rows where `preserveNonEmpty` kept at least one field that the recomputed
   * classification would otherwise have blanked. */
  preserved: number;
}

function isEmptyCell(v: Cell | undefined): boolean {
  return String(v ?? '').trim() === '';
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
  opts: ReclassifyOptions = {},
): Promise<ReclassifyResult> {
  const { preserveNonEmpty = false, dryRun = false } = opts;
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
  let preserved = 0;

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

    // Non-destructive mode: a rule that yields nothing must not blank a value
    // the row already has (e.g. a curated Money Pro category on a merchant no
    // rule matches). Restore the existing value wherever the recompute emptied
    // a previously non-empty classification field.
    if (preserveNonEmpty) {
      let kept = false;
      for (const h of OVERRIDABLE) {
        const i = HEADERS.indexOf(h);
        if (isEmptyCell(merged[i]) && !isEmptyCell(existingRow[i])) {
          merged[i] = existingRow[i] ?? '';
          kept = true;
        }
      }
      // The empty-cell check can't protect `kind`: the no-rule fallback emits
      // 'expense', never a blank. When no counterparty rule matched
      // (classified.counterparty is null), the fallback must not downgrade a
      // curated kind — e.g. Money Pro transfers and incomes, which have no
      // bankCategory or description for rules to rediscover them from.
      const kindIdx = HEADERS.indexOf('kind');
      if (
        classified.counterparty === null &&
        !isEmptyCell(existingRow[kindIdx]) &&
        merged[kindIdx] !== existingRow[kindIdx]
      ) {
        merged[kindIdx] = existingRow[kindIdx] ?? '';
        kept = true;
      }
      if (kept) preserved++;
    }

    if (rowsEqual(existingRow, merged)) {
      unchanged++;
      return;
    }
    merged[updatedAtCol] = now;
    toUpdate.push({ rowNum: idx + 2, row: merged });
  });

  if (!dryRun && toUpdate.length > 0) {
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

  return { appended: 0, updated: toUpdate.length, unchanged, preserved };
}

/**
 * Merge a field patch into an existing `operations` row. Pure: returns a new
 * row, bumps `updatedAt`, and optionally pins fields into `manualOverride` so
 * later imports never overwrite them. The screen building a Confirm-tab batch
 * already holds the rows in memory, so it can patch them and send one
 * `batchUpdateValues` without re-reading the sheet.
 */
export function applyOperationPatch(
  existingRow: Row,
  patch: OperationPatch,
  pin: readonly EditableField[] = [],
): Row {
  const row = padRow([...existingRow]);
  for (const key of Object.keys(patch) as EditableField[]) {
    const i = HEADERS.indexOf(key);
    if (i >= 0) row[i] = patch[key] ?? '';
  }
  if (pin.length > 0) {
    const oIdx = HEADERS.indexOf('manualOverride');
    const set = parseOverride(String(row[oIdx] ?? ''));
    for (const f of pin) set.add(f);
    row[oIdx] = [...set].join(',');
  }
  row[HEADERS.indexOf('updatedAt')] = new Date().toISOString();
  return row;
}

/**
 * Fast append path for interactive entry (Receipt items, Cash). Appends rows in
 * a single call and never reads the whole `operations` tab — so it stays
 * constant-time on a large sheet (see the mobile-latency rule in CLAUDE.md).
 *
 * Idempotency is the caller's job: pass a unique `sourceId` per op (it's mixed
 * into the row id) and disable the submit button on click. `accountName` is the
 * canonical balance the user picked; it's written verbatim, bypassing the
 * instrument-routing lookup that batch imports use.
 */
export async function appendManualOperations(
  api: SheetsAPI,
  ops: ClassifiedOperation[],
  accountName: string,
  sourceChannel: SourceChannel = 'manual',
): Promise<number> {
  if (ops.length === 0) return 0;
  const now = new Date().toISOString();
  const rows: Row[] = [];
  for (const op of ops) {
    const id = await operationId(op, sourceChannel);
    rows.push(buildRow(op, id, sourceChannel, accountName, now, now));
  }
  await api.appendValues(RANGE_FULL, rows);
  return rows.length;
}

/** Single-op convenience over {@link appendManualOperations}. */
export async function appendManualOperation(
  api: SheetsAPI,
  op: ClassifiedOperation,
  accountName: string,
  sourceChannel: SourceChannel = 'manual',
): Promise<void> {
  await appendManualOperations(api, [op], accountName, sourceChannel);
}

/**
 * Single-operation fast path for interactive edits (Confirm tap, Cash entry).
 * Reads only the id column to locate the row, then that one row — never the
 * whole `operations` tab — so it stays constant-time as the sheet grows. See
 * the mobile-latency rule in CLAUDE.md. Returns false if no row has that id.
 */
export async function updateOperationFields(
  api: SheetsAPI,
  id: string,
  patch: OperationPatch,
  opts: { pin?: readonly EditableField[] } = {},
): Promise<boolean> {
  const ids = await api.getValues(`${TAB}!A2:A`);
  const idx = ids.findIndex((r) => r[0] === id);
  if (idx < 0) return false;
  const rowNum = idx + 2;
  const cur = await api.getValues(`${TAB}!A${rowNum}:${LAST_COL}${rowNum}`);
  const row = applyOperationPatch(cur[0] ?? [], patch, opts.pin ?? []);
  await api.updateValues(`${TAB}!A${rowNum}:${LAST_COL}${rowNum}`, [row]);
  return true;
}
