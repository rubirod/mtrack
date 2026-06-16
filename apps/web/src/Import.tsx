import { useState } from 'react';
import {
  classify,
  loadClassifyConfig,
  parseCsvStatement,
  pushOperations,
  reconcile,
  type AmbiguityReason,
  type ClassifiedOperation,
  type ExistingOp,
  type Operation,
} from '@mtrack/core';
import type { Settings } from './settings';
import { createSheetsAPI } from './google';

interface Props {
  settings: Settings;
}

interface ReviewItem {
  op: ClassifiedOperation;
  candidates: ExistingOp[];
  reason: AmbiguityReason;
  balance: string;
}

interface Reconciled {
  channel: string;
  parsed: number;
  toAdd: ClassifiedOperation[];
  skipped: number;
  review: ReviewItem[];
}

type Decision = 'add' | 'skip';

/**
 * Statement import.
 *
 * Pick a file (CSV today), parse + classify locally, then reconcile against the
 * operations already in the sheet (Money Pro is the curated master). Rows the
 * master already has are skipped; clearly-new ones are queued to import; unclear
 * ones are listed for review (default: skip, i.e. trust the master). Nothing is
 * written until the import is confirmed.
 */
export function ImportScreen({ settings }: Props): React.JSX.Element {
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Namespaces a statement by source (default "csv"). A distinct label per bank
  // keeps card tails from colliding in the routing table.
  const [channel, setChannel] = useState('csv');
  const [rec, setRec] = useState<Reconciled | null>(null);
  // Per-review-item decision; a missing entry means "skip" (trust the master).
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});

  async function handleFile(file: File): Promise<void> {
    setError(null);
    setStatus(null);
    setRec(null);
    setDecisions({});
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
      const review: ReviewItem[] = result.ambiguous.map((a) => ({
        ...a,
        balance: routing.get(`${sourceChannel}|${a.op.account ?? ''}`) || '(unrouted)',
      }));
      setRec({
        channel: sourceChannel,
        parsed: classified.length,
        toAdd: result.toAdd,
        skipped: result.skipped.length,
        review,
      });
      setStatus(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function setAllDecisions(d: Decision): void {
    if (!rec) return;
    const next: Record<number, Decision> = {};
    rec.review.forEach((_, i) => {
      next[i] = d;
    });
    setDecisions(next);
  }

  const reviewAdds = rec ? rec.review.filter((_, i) => decisions[i] === 'add') : [];
  const importCount = rec ? rec.toAdd.length + reviewAdds.length : 0;

  async function runImport(): Promise<void> {
    if (!rec) return;
    setBusy(true);
    setError(null);
    try {
      const api = createSheetsAPI(settings.spreadsheetId);
      const toImport = [...rec.toAdd, ...reviewAdds.map((r) => r.op)];
      setStatus(`Importing ${toImport.length} operations…`);
      const result = await pushOperations(api, toImport, rec.channel);
      setStatus(
        `Done. Appended ${result.appended}, updated ${result.updated}, unchanged ${result.unchanged}.`,
      );
      setRec(null);
      setDecisions({});
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
            <li>{rec.review.length} to review below</li>
            <li>
              <strong>{importCount} to import</strong>
            </li>
          </ul>
          <button className="primary" onClick={runImport} disabled={busy || importCount === 0}>
            {busy ? 'Working…' : `Import ${importCount}`}
          </button>
        </div>
      )}

      {rec && rec.review.length > 0 && (
        <div className="card">
          <h2>Review ({rec.review.length})</h2>
          <p className="hint">
            These could already be in the master. Default is <em>skip</em> (trust
            Money Pro); switch to <em>add</em> the ones that are genuinely new.
          </p>
          <div className="row" style={{ gap: 8 }}>
            <button className="secondary" onClick={() => setAllDecisions('skip')} disabled={busy}>
              All → skip
            </button>
            <button className="secondary" onClick={() => setAllDecisions('add')} disabled={busy}>
              All → add
            </button>
          </div>
          <table className="rules">
            <thead>
              <tr>
                <th>date</th>
                <th>balance</th>
                <th>amount</th>
                <th>description</th>
                <th>why</th>
                <th>decision</th>
              </tr>
            </thead>
            <tbody>
              {rec.review.map((r, i) => (
                <tr key={i}>
                  <td>{r.op.date}</td>
                  <td>{r.balance}</td>
                  <td>{r.op.amount}</td>
                  <td>
                    {r.op.description}
                    {r.reason === 'multiple-matches' && r.candidates.length > 0 && (
                      <div className="hint">
                        master same day: {r.candidates.map((c) => c.amount).join(', ')}
                      </div>
                    )}
                  </td>
                  <td>
                    {r.reason === 'unmatched-transfer'
                      ? 'looks like transfer'
                      : `${r.candidates.length} matches`}
                  </td>
                  <td>
                    <select
                      value={decisions[i] ?? 'skip'}
                      disabled={busy}
                      onChange={(e) =>
                        setDecisions({ ...decisions, [i]: e.target.value as Decision })
                      }
                    >
                      <option value="skip">skip</option>
                      <option value="add">add</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
