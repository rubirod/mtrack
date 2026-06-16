import { useState } from 'react';
import {
  classify,
  loadClassifyConfig,
  parseCsvStatement,
  pushOperations,
  reconcile,
  type AmbiguousItem,
  type ClassifiedOperation,
  type Operation,
} from '@mtrack/core';
import type { Settings } from './settings';
import { createSheetsAPI } from './google';

interface Props {
  settings: Settings;
}

interface Reconciled {
  channel: string;
  parsed: number;
  toAdd: ClassifiedOperation[];
  skipped: number;
  ambiguous: AmbiguousItem[];
}

/**
 * Statement import.
 *
 * Pick a file (CSV today), parse + classify locally, then reconcile against the
 * operations already in the sheet (Money Pro is the curated master) before
 * writing. Rows the master already has are skipped, unclear ones are surfaced
 * for review, and only genuinely new operations are imported on confirmation.
 */
export function ImportScreen({ settings }: Props): React.JSX.Element {
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Namespaces a statement by source (default "csv"). A distinct label per bank
  // keeps card tails from colliding in the routing table.
  const [channel, setChannel] = useState('csv');
  const [rec, setRec] = useState<Reconciled | null>(null);

  async function handleFile(file: File): Promise<void> {
    setError(null);
    setStatus(null);
    setRec(null);
    setBusy(true);
    try {
      const api = createSheetsAPI(settings.spreadsheetId);

      setStatus('Loading rules from the spreadsheet…');
      const config = await loadClassifyConfig(api);

      const ops = await parseFile(file);
      const classified = ops.map((op) => classify(op, config));
      const sourceChannel = channel.trim() || 'csv';

      setStatus(`Parsed ${classified.length}. Reconciling against existing operations…`);
      const [opRows, accRows] = await Promise.all([
        api.getValues('operations!B2:H'),
        api.getValues('accounts!A2:C'),
      ]);

      const existing = opRows
        .map((r) => ({
          day: String(r[0] ?? '').slice(0, 10),
          accountName: String(r[2] ?? ''),
          amount: parseAmount(r[6]),
        }))
        .filter((e) => e.accountName && e.day);

      const routing = new Map<string, string>();
      for (const r of accRows) {
        const sc = r[0];
        if (sc) routing.set(`${sc}|${r[1] ?? ''}`, r[2] ?? '');
      }

      const result = reconcile(classified, existing, routing, sourceChannel);
      setRec({
        channel: sourceChannel,
        parsed: classified.length,
        toAdd: result.toAdd,
        skipped: result.skipped.length,
        ambiguous: result.ambiguous,
      });
      setStatus(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runImport(): Promise<void> {
    if (!rec) return;
    setBusy(true);
    setError(null);
    try {
      const api = createSheetsAPI(settings.spreadsheetId);
      setStatus(`Importing ${rec.toAdd.length} new operations…`);
      const result = await pushOperations(api, rec.toAdd, rec.channel);
      setStatus(
        `Done. Appended ${result.appended}, updated ${result.updated}, unchanged ${result.unchanged}.`,
      );
      setRec(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Import statement</h1>
      <p className="muted">
        The statement is parsed in the browser, then reconciled against the
        operations already in the sheet before anything is written. Rows the
        master (Money Pro) already has are skipped; only genuinely new
        operations are imported.
      </p>

      <div className="card">
        <label htmlFor="channel">Source channel</label>
        <input
          id="channel"
          type="text"
          value={channel}
          placeholder="csv"
          disabled={busy}
          onChange={(e) => setChannel(e.target.value)}
        />
        <div className="hint">
          A label for where this statement came from. Use a distinct one per
          bank so card tails don't collide in routing. Set it before choosing
          the file.
        </div>
        <label htmlFor="file">Statement file (CSV)</label>
        <input
          id="file"
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
        />
        <div className="hint">
          CSV today. PDF will be handled via Claude vision — same pipeline that
          parses receipts.
        </div>
      </div>

      {rec && (
        <div className="card">
          <h2>Reconciliation</h2>
          <ul>
            <li>{rec.parsed} parsed from the file</li>
            <li>{rec.skipped} already in the master (skipped)</li>
            <li>{rec.ambiguous.length} need review</li>
            <li>
              <strong>{rec.toAdd.length} new to import</strong>
            </li>
          </ul>
          {rec.ambiguous.length > 0 && (
            <p className="hint">
              Review of the {rec.ambiguous.length} ambiguous operations is
              coming next; for now only the {rec.toAdd.length} clearly-new ones
              are imported.
            </p>
          )}
          <button
            className="primary"
            onClick={runImport}
            disabled={busy || rec.toAdd.length === 0}
          >
            {busy ? 'Working…' : `Import ${rec.toAdd.length} new`}
          </button>
        </div>
      )}

      {status && <div className="ok">{status}</div>}
      {error && <div className="error">{error}</div>}
    </>
  );
}

async function parseFile(file: File): Promise<Operation[]> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.csv')) {
    const text = await file.text();
    return parseCsvStatement(text);
  }
  if (lower.endsWith('.pdf')) {
    throw new Error('PDF support coming via Claude vision (TODO).');
  }
  throw new Error(`Unknown format: ${file.name}`);
}

/** Locale-tolerant parse of a number read back from Sheets (comma decimal,
 * optional space grouping). */
function parseAmount(v: unknown): number {
  return parseFloat(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
}
