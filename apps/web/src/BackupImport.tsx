import { useEffect, useMemo, useState } from 'react';
import {
  assertWritableTab,
  pushOperations,
  type ConvertedMoneyPro,
  type Row,
  type SheetsAPI,
} from '@mtrack/core';
import type { Settings } from './settings';
import { createSheetsAPI } from './google';
import { applyConvert, loadBackup, type LoadedBackup } from './backup-import';

/**
 * Money Pro backup import. One-time migration for historical data.
 *
 * The .back container is parsed in the browser, the embedded SQLite is read
 * via lazily-loaded sql.js. The user picks a date range and which entities
 * to import; `pushOperations` is idempotent (via `sourceId`), so re-running
 * with the same range upserts the same rows.
 */

interface Props {
  settings: Settings;
}

export function BackupImport({ settings }: Props): React.JSX.Element {
  const api = useMemo(
    () => createSheetsAPI(settings.spreadsheetId),
    [settings.spreadsheetId],
  );

  const [loaded, setLoaded] = useState<LoadedBackup | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [fromDate, setFromDate] = useState(() => `${new Date().getFullYear()}-01-01`);
  const [toDate, setToDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [withBalances, setWithBalances] = useState(true);
  const [withCategories, setWithCategories] = useState(true);
  const [withOperations, setWithOperations] = useState(true);
  // Money Pro keeps closed cards/accounts as hidden balances. Their
  // transactions still import, so off-by-default leaves those cards
  // unroutable; turn this on to bring the archived balances in too.
  const [withArchived, setWithArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ConvertedMoneyPro | null>(null);

  useEffect(() => {
    if (!loaded) {
      setPreview(null);
      return;
    }
    try {
      setPreview(
        applyConvert(loaded, {
          fromDate: fromDate ? new Date(fromDate) : undefined,
          toDate: toDate ? new Date(toDate) : undefined,
          includeArchivedBalances: withArchived,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [loaded, fromDate, toDate, withArchived]);

  async function handleFile(file: File): Promise<void> {
    setError(null);
    setStatus('Reading backup (loading SQLite engine on first run)…');
    setBusy(true);
    try {
      const result = await loadBackup(file);
      setLoaded(result);
      setFileName(file.name);
      setStatus(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function run(): Promise<void> {
    if (!preview) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const tabs = new Set(await api.listTabs());
      const parts: string[] = [];

      if (withBalances && preview.balances.length) {
        setStatus(`Merging ${preview.balances.length} balances…`);
        await mergeByKey(
          api,
          'balances',
          ['name', 'currency', 'type', 'archived'],
          preview.balances.map(
            (b) => [b.name, b.currency, b.type, b.archived ? 'TRUE' : ''] as Row,
          ),
          0,
          tabs,
        );
        parts.push(`balances ${preview.balances.length}`);
      }

      if (withCategories && preview.categories.length) {
        setStatus(`Merging ${preview.categories.length} categories…`);
        await mergeByKey(
          api,
          'categories',
          ['name', 'parent'],
          preview.categories.map((c) => [c.name, c.parent] as Row),
          0,
          tabs,
        );
        parts.push(`categories ${preview.categories.length}`);
      }

      if (withOperations && preview.operations.length) {
        // Register one `accounts` routing entry per balance touched, so
        // resolveAccountName resolves `account = balance name` → balance.
        setStatus('Registering manual routing entries…');
        const usedBalances = new Set<string>();
        for (const op of preview.operations) {
          if (op.account) usedBalances.add(op.account);
        }
        await mergeRouting(api, usedBalances, tabs);

        setStatus(`Pushing ${preview.operations.length} operations…`);
        const result = await pushOperations(api, preview.operations, 'manual');
        parts.push(
          `operations: +${result.appended}, updated ${result.updated}, unchanged ${result.unchanged}`,
        );
      }

      setStatus(`Done. ${parts.join('; ')}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2>Import from Money Pro backup</h2>
      <p className="hint">
        One-off migration from a Money Pro <code>.back</code> file. SQLite is
        parsed locally in the browser. Idempotent — re-running with the same
        date range upserts the same rows.
      </p>

      <div className="field">
        <label htmlFor="backup">Backup file</label>
        <input
          id="backup"
          type="file"
          accept=".back,application/octet-stream"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
        />
        {fileName && <div className="hint">Loaded: <code>{fileName}</code></div>}
      </div>

      {loaded && (
        <>
          <div className="row" style={{ gap: 12 }}>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="from">From</label>
              <input
                id="from"
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                disabled={busy}
              />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="to">To</label>
              <input
                id="to"
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                disabled={busy}
              />
            </div>
          </div>

          <div className="card">
            <CheckboxRow
              label={`Balances (${preview?.balances.length ?? 0})`}
              checked={withBalances}
              onChange={setWithBalances}
              disabled={busy}
            />
            <CheckboxRow
              label="Include archived / hidden balances"
              checked={withArchived}
              onChange={setWithArchived}
              disabled={busy || !withBalances}
            />
            <CheckboxRow
              label={`Categories (${preview?.categories.length ?? 0})`}
              checked={withCategories}
              onChange={setWithCategories}
              disabled={busy}
            />
            <CheckboxRow
              label={`Operations (${preview?.operations.length ?? 0} in range)`}
              checked={withOperations}
              onChange={setWithOperations}
              disabled={busy}
            />
          </div>

          <button className="primary" onClick={run} disabled={busy}>
            {busy ? 'Working…' : 'Run import'}
          </button>
        </>
      )}

      {status && <div className="ok">{status}</div>}
      {error && <div className="error">{error}</div>}
    </>
  );
}

function CheckboxRow({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
}): React.JSX.Element {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 'auto' }}
      />
      <span>{label}</span>
    </label>
  );
}

/**
 * Upserts rows into a tab by the value in column `keyColIdx`. Existing rows
 * with the same key are left alone (manual edits win); new keys are appended.
 */
async function mergeByKey(
  api: SheetsAPI,
  tab: string,
  headers: string[],
  rows: Row[],
  keyColIdx: number,
  existingTabs: Set<string>,
): Promise<void> {
  if (!existingTabs.has(tab)) {
    await api.ensureTab(tab);
    existingTabs.add(tab);
  } else {
    // Bail out instead of appending into a same-named tab the user owns.
    await assertWritableTab(api, tab, headers);
  }
  const current = await safeRead(api, `${tab}!A2:Z`);
  if (current.length === 0) {
    await api.updateValues(`${tab}!A1`, [headers as unknown as Row, ...rows]);
    return;
  }
  const seen = new Set<string>();
  for (const r of current) {
    const v = r[keyColIdx];
    if (v) seen.add(String(v));
  }
  const toAdd = rows.filter((r) => !seen.has(String(r[keyColIdx] ?? '')));
  if (toAdd.length === 0) return;
  await api.appendValues(`${tab}!A:Z`, toAdd);
}

async function mergeRouting(
  api: SheetsAPI,
  balances: Set<string>,
  existingTabs: Set<string>,
): Promise<void> {
  if (!existingTabs.has('accounts')) {
    await api.ensureTab('accounts');
    existingTabs.add('accounts');
  }
  const current = await safeRead(api, 'accounts!A2:C');
  const seen = new Set<string>();
  for (const row of current) {
    const sc = row[0];
    const tail = row[1];
    if (sc) seen.add(`${sc}|${tail ?? ''}`);
  }
  const toAdd: Row[] = [];
  for (const b of balances) {
    if (seen.has(`manual|${b}`)) continue;
    toAdd.push(['manual', b, b]);
  }
  if (current.length === 0) {
    await api.updateValues('accounts!A1', [
      ['sourceChannel', 'tail', 'balance'] as Row,
      ...toAdd,
    ]);
    return;
  }
  if (toAdd.length === 0) return;
  await api.appendValues('accounts!A:C', toAdd);
}

async function safeRead(api: SheetsAPI, range: string): Promise<string[][]> {
  try {
    return await api.getValues(range);
  } catch {
    return [];
  }
}
