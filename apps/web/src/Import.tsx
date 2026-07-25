import { useEffect, useState } from 'react';
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

/**
 * Everything the reconciliation needs, kept so that changing the channel
 * re-runs it locally instead of re-reading the whole `operations` tab.
 */
interface ParsedSource {
  classified: ClassifiedOperation[];
  existing: ExistingOp[];
  routing: Map<string, string>;
}

type Decision = 'add' | 'skip';

/** Last channel imported with, so the next import defaults to it. */
const CHANNEL_KEY = 'mtrack.import.channel.v1';
/** Sentinel option that reveals the free-text field for a brand-new bank. */
const NEW_CHANNEL = '__new_channel__';

function readLastChannel(): string {
  try {
    return localStorage.getItem(CHANNEL_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeLastChannel(c: string): void {
  try {
    localStorage.setItem(CHANNEL_KEY, c);
  } catch {
    /* ignore */
  }
}

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
  // Namespaces a statement by source. A distinct label per bank keeps card
  // tails from colliding in the routing table — and picking the wrong one is
  // costly: the routing key is `channel|tail`, so a mismatched channel routes
  // nothing, and every row of the statement looks new. Hence a picker over the
  // channels the sheet actually routes, rather than a free-text field.
  const [channels, setChannels] = useState<string[]>([]);
  const [channel, setChannel] = useState<string>(() => readLastChannel());
  const [newChannel, setNewChannel] = useState('');
  const [source, setSource] = useState<ParsedSource | null>(null);
  const [rec, setRec] = useState<Reconciled | null>(null);
  // Per-review-item decision; a missing entry means "skip" (trust the master).
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});

  const pickingNew = channel === NEW_CHANNEL;
  const effectiveChannel = (pickingNew ? newChannel : channel).trim();

  // The channels the `accounts` tab routes. A failure here is not fatal: the
  // "new channel" option still lets the user type one.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const rows = await createSheetsAPI(settings.spreadsheetId).getValues('accounts!A2:A');
        if (!alive) return;
        const seen = [...new Set(rows.map((r) => String(r[0] ?? '').trim()).filter(Boolean))];
        seen.sort();
        setChannels(seen);
      } catch {
        /* offline, or no token yet — the free-text fallback covers it */
      }
    })();
    return () => {
      alive = false;
    };
  }, [settings.spreadsheetId]);

  // Reconciliation is pure once the file is parsed, so switching channels
  // re-runs it instantly — no need to re-pick the file to fix a wrong choice.
  useEffect(() => {
    if (!source) {
      setRec(null);
      return;
    }
    const result = reconcile(source.classified, source.existing, source.routing, effectiveChannel);
    setDecisions({});
    setRec({
      channel: effectiveChannel,
      parsed: source.classified.length,
      toAdd: result.toAdd,
      skipped: result.skipped.length,
      review: result.ambiguous.map((a) => ({
        ...a,
        balance: source.routing.get(`${effectiveChannel}|${a.op.account ?? ''}`) || '(unrouted)',
      })),
    });
  }, [source, effectiveChannel]);

  async function handleFile(file: File): Promise<void> {
    setError(null);
    setStatus(null);
    setSource(null);
    setRec(null);
    setDecisions({});
    setBusy(true);
    try {
      const api = createSheetsAPI(settings.spreadsheetId);

      setStatus('Loading rules from the spreadsheet…');
      const config = await loadClassifyConfig(api);

      const ops = await parseFile(file);
      const classified = ops.map((op) => classify(op, config));

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

      // The effect above turns this into a reconciliation, and re-runs it on
      // every later channel change.
      setSource({ classified, existing, routing });
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
      writeLastChannel(rec.channel);
      setStatus(
        `Done. Appended ${result.appended}, updated ${result.updated}, unchanged ${result.unchanged}.`,
      );
      setSource(null);
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
        <select
          id="channel"
          value={channel}
          disabled={busy}
          onChange={(e) => setChannel(e.target.value)}
        >
          <option value="">— pick —</option>
          {channels.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
          {channel && !pickingNew && !channels.includes(channel) && (
            <option value={channel}>{channel}</option>
          )}
          <option value={NEW_CHANNEL}>New channel…</option>
        </select>
        {pickingNew && (
          <input
            type="text"
            value={newChannel}
            placeholder="e.g. mybank-csv"
            disabled={busy}
            onChange={(e) => setNewChannel(e.target.value)}
          />
        )}
        <div className="hint">
          Where this statement came from — the channels your <code>accounts</code>{' '}
          tab routes. Card tails are routed per channel, so the wrong one routes
          nothing and every row looks new. Switching it re-runs the
          reconciliation, so a wrong pick costs nothing.
        </div>
        <label htmlFor="file">Statement file (CSV)</label>
        <input
          id="file"
          type="file"
          accept=".csv,text/csv"
          disabled={busy || !effectiveChannel}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
        />
        <div className="hint">
          {effectiveChannel
            ? 'CSV today. PDF will be handled via Claude vision — same pipeline that parses receipts.'
            : 'Pick a source channel first.'}
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
