/**
 * Money Pro backup loader for the PWA.
 *
 * 1. Parses the proprietary `.back` container (custom `name\nlength\nbytes`
 *    layout) — pure JS, no deps.
 * 2. Loads sql.js lazily on first call and reads the embedded SQLite DB.
 * 3. Hands the raw rows to `convertMoneyPro` from `@mtrack/core`, which
 *    does the bank-agnostic mapping into mtrack shapes.
 *
 * sql.js is ~1MB of WASM + JS. The dynamic imports below ensure it lands
 * in a separate Vite chunk that's only fetched when the user actually
 * picks a backup file.
 */

import type {
  MoneyProData,
  MoneyProConvertOptions,
  ConvertedMoneyPro,
} from '@mtrack/core';
import { convertMoneyPro } from '@mtrack/core';

/** Parses the `name\nlength\nbytes` container. */
function parseBackContainer(buf: ArrayBuffer): Map<string, Uint8Array> {
  const data = new Uint8Array(buf);
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder('utf-8');
  let pos = 0;
  while (pos < data.length) {
    const nl1 = indexOfByte(data, 0x0a, pos);
    if (nl1 < 0) break;
    const name = dec.decode(data.subarray(pos, nl1));
    const nl2 = indexOfByte(data, 0x0a, nl1 + 1);
    if (nl2 < 0) break;
    const len = parseInt(dec.decode(data.subarray(nl1 + 1, nl2)), 10);
    if (!Number.isFinite(len)) break;
    const start = nl2 + 1;
    out.set(name, data.subarray(start, start + len));
    pos = start + len;
    if (pos < data.length && data[pos] === 0x0a) pos++;
  }
  return out;
}

function indexOfByte(arr: Uint8Array, byte: number, from: number): number {
  for (let i = from; i < arr.length; i++) if (arr[i] === byte) return i;
  return -1;
}

interface SqlDb {
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  close(): void;
}

let sqlJsLoader: Promise<(bytes: Uint8Array) => SqlDb> | null = null;

function loadSqlJs(): Promise<(bytes: Uint8Array) => SqlDb> {
  if (sqlJsLoader) return sqlJsLoader;
  sqlJsLoader = (async () => {
    const [{ default: initSqlJs }, { default: wasmUrl }] = await Promise.all([
      import('sql.js'),
      import('sql.js/dist/sql-wasm.wasm?url'),
    ]);
    const SQL = await initSqlJs({ locateFile: () => wasmUrl });
    return (bytes: Uint8Array) => new SQL.Database(bytes) as unknown as SqlDb;
  })();
  return sqlJsLoader;
}

function rowsFromExec(
  res: Array<{ columns: string[]; values: unknown[][] }>,
): Record<string, unknown>[] {
  if (!res.length) return [];
  const { columns, values } = res[0]!;
  return values.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((c, i) => (obj[c] = row[i]));
    return obj;
  });
}

export interface LoadedBackup {
  raw: MoneyProData;
}

/** Reads a .back file and produces the raw Money Pro entity arrays. */
export async function loadBackup(file: File): Promise<LoadedBackup> {
  const buf = await file.arrayBuffer();
  const entries = parseBackContainer(buf);

  let dbBytes: Uint8Array | null = null;
  for (const [name, bytes] of entries) {
    if (name.endsWith('database.sql')) {
      dbBytes = bytes;
      break;
    }
  }
  if (!dbBytes) {
    throw new Error('No database.sql inside the backup. Is this a Money Pro .back file?');
  }

  const open = await loadSqlJs();
  const db = open(dbBytes);
  try {
    const balances = rowsFromExec(
      db.exec(
        'SELECT primaryKey, name, description, currencyKey, balanceType, isDeleted, isHidden FROM balance',
      ),
    ) as unknown as MoneyProData['balances'];
    const categories = rowsFromExec(
      db.exec(
        'SELECT primaryKey, name, parentPrimaryKey, flowType, isDeleted FROM category',
      ),
    ) as unknown as MoneyProData['categories'];
    const transactions = rowsFromExec(
      db.exec(
        'SELECT primaryKey, date, sum, description, transactionType, cashFlowPrimaryKey, secondCashFlowPrimaryKey, secondSum, isDeleted, isHidden FROM transactions',
      ),
    ) as unknown as MoneyProData['transactions'];
    const splits = rowsFromExec(
      db.exec(
        'SELECT primaryKey, transactionsPrimaryKey, categoryPrimaryKey, sum, "index" FROM splitTransaction',
      ),
    ) as unknown as MoneyProData['splits'];
    return { raw: { balances, categories, transactions, splits } };
  } finally {
    db.close();
  }
}

/** Re-applies the convertor with current options to refresh preview counts. */
export function applyConvert(loaded: LoadedBackup, opts: MoneyProConvertOptions): ConvertedMoneyPro {
  return convertMoneyPro(loaded.raw, opts);
}
