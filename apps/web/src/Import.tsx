import { useState } from 'react';
import {
  classify,
  loadClassifyConfig,
  parseCsvStatement,
  pushOperations,
  type Operation,
} from '@mtrack/core';
import type { Settings } from './settings';
import { createSheetsAPI } from './google';

interface Props {
  settings: Settings;
}

/**
 * Statement import.
 *
 * Flow: user picks a file (CSV today, PDF via Claude vision later). The PWA
 * parses it locally, pulls rules from the spreadsheet, classifies, and
 * upserts into the `operations` tab. Entirely client-side, no backend.
 */
export function ImportScreen({ settings }: Props): React.JSX.Element {
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Namespaces a statement by source (default "csv"). A distinct label per bank
  // keeps card tails from colliding in the routing table.
  const [channel, setChannel] = useState('csv');

  async function handleFile(file: File): Promise<void> {
    setError(null);
    setStatus(null);
    setBusy(true);
    try {
      const api = createSheetsAPI(settings.spreadsheetId);

      setStatus('Loading rules from the spreadsheet…');
      const config = await loadClassifyConfig(api);

      const ops = await parseFile(file);
      setStatus(`Parsed ${ops.length} operations. Classifying…`);
      const classified = ops.map((op) => classify(op, config));

      const sourceChannel = channel.trim() || 'csv';
      setStatus(`Pushing to operations (channel "${sourceChannel}")…`);
      const result = await pushOperations(api, classified, sourceChannel);
      setStatus(
        `Done. Appended: ${result.appended}, updated: ${result.updated}, unchanged: ${result.unchanged}.`,
      );
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
        The statement is parsed in the browser, rules come from the spreadsheet,
        operations are upserted into the <code>operations</code> tab. Idempotent:
        re-importing the same file doesn't duplicate anything.
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
