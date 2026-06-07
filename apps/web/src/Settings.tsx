import { useState } from 'react';
import { seedConfigTabs } from '@mtrack/core';
import type { Settings } from './settings';
import { saveSettings } from './settings';
import {
  createSheetsAPI,
  getSpreadsheetMeta,
  listSpreadsheets,
  signOut,
  type SpreadsheetMeta,
} from './google';
import { BackupImport } from './BackupImport';

interface Props {
  settings: Settings;
  onChanged: (s: Settings) => void;
}

/**
 * Settings — the "More" tab content. Only ever rendered after first-launch:
 * the user is already signed in to Google, has an Anthropic key and a
 * spreadsheet picked. This screen lets them rotate any of those values,
 * sign out (clears the Google token but keeps the rest), or reset
 * everything. It also houses the one-off Money Pro backup import.
 */
export function SettingsScreen({ settings, onChanged }: Props): React.JSX.Element {
  const [anthropicKey, setAnthropicKey] = useState(settings.anthropicKey);
  const [picked, setPicked] = useState<SpreadsheetMeta>({
    id: settings.spreadsheetId,
    title: settings.spreadsheetName,
  });
  const [sheets, setSheets] = useState<SpreadsheetMeta[] | null>(null);
  const [pasteInput, setPasteInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const dirty =
    anthropicKey !== settings.anthropicKey || picked.id !== settings.spreadsheetId;

  async function changeSheet(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const list = await listSpreadsheets();
      setSheets(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function usePastedUrl(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const id = extractSpreadsheetId(pasteInput);
      if (!id) throw new Error('Cannot extract a spreadsheet ID');
      const meta = await getSpreadsheetMeta(id);
      setPicked(meta);
      setStatus(`Picked: ${meta.title}. Tap Save to apply.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function save(): void {
    setError(null);
    setStatus(null);
    if (!anthropicKey.startsWith('sk-ant-')) {
      setError('Anthropic key must start with "sk-ant-"');
      return;
    }
    if (!picked.id) {
      setError('No spreadsheet picked');
      return;
    }
    const next: Settings = {
      anthropicKey,
      spreadsheetId: picked.id,
      spreadsheetName: picked.title,
    };
    saveSettings(next);
    onChanged(next);
    setStatus('Saved.');
    setSheets(null);
    setPasteInput('');
  }

  return (
    <>
      <h1>Settings</h1>
      <p className="hint">Stored locally on this device.</p>

      <h2>Anthropic</h2>
      <div className="field">
        <label htmlFor="anthropic">API key</label>
        <input
          id="anthropic"
          type="password"
          autoComplete="off"
          placeholder="sk-ant-…"
          value={anthropicKey}
          onChange={(e) => setAnthropicKey(e.target.value)}
        />
      </div>

      <h2>Spreadsheet</h2>
      <div className="card">
        <strong>{picked.title || '— none picked —'}</strong>
        {picked.id && (
          <div className="hint">
            ID: <code>{picked.id}</code>
          </div>
        )}
      </div>

      {sheets === null ? (
        <button
          className="secondary"
          style={{ marginTop: 8 }}
          onClick={changeSheet}
          disabled={busy}
        >
          {busy ? 'Loading…' : 'Change spreadsheet'}
        </button>
      ) : (
        <>
          <div className="field" style={{ marginTop: 8 }}>
            <label htmlFor="pick">Pick from your sheets ({sheets.length})</label>
            <select
              id="pick"
              value={picked.id}
              onChange={(e) => {
                const found = sheets.find((s) => s.id === e.target.value);
                if (found) setPicked(found);
              }}
            >
              {sheets.map((s) => (
                <option key={s.id} value={s.id}>{s.title}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="paste">Or paste a URL (for sheets shared by link)</label>
            <input
              id="paste"
              type="text"
              autoComplete="off"
              placeholder="https://docs.google.com/spreadsheets/d/…"
              value={pasteInput}
              onChange={(e) => setPasteInput(e.target.value)}
            />
            <button
              className="secondary"
              style={{ marginTop: 8 }}
              onClick={usePastedUrl}
              disabled={busy || !pasteInput.trim()}
            >
              {busy ? 'Checking…' : 'Use this URL'}
            </button>
          </div>
        </>
      )}

      {dirty && (
        <button className="primary" style={{ marginTop: 16 }} onClick={save} disabled={busy}>
          Save changes
        </button>
      )}

      <SeedButton spreadsheetId={settings.spreadsheetId} />

      {status && <div className="ok">{status}</div>}
      {error && <div className="error">{error}</div>}

      <hr style={{ margin: '32px 0', border: 0, borderTop: '1px solid var(--border)' }} />
      <BackupImport settings={settings} />

      <hr style={{ margin: '32px 0', border: 0, borderTop: '1px solid var(--border)' }} />
      <h2>Session</h2>

      <button
        className="secondary"
        style={{ marginTop: 8 }}
        onClick={() => {
          signOut();
          window.location.reload();
        }}
      >
        Sign out of Google
      </button>
      <div className="hint" style={{ marginTop: 4 }}>
        Clears the Google access token. Anthropic key and spreadsheet stay.
        You'll be asked to sign in again next time you read or write the sheet.
      </div>

      <button
        className="secondary"
        style={{ marginTop: 16 }}
        onClick={() => {
          if (
            !confirm(
              'Erase Anthropic key, spreadsheet config and Google session from this device?',
            )
          ) {
            return;
          }
          signOut();
          localStorage.clear();
          window.location.reload();
        }}
      >
        Reset everything
      </button>
      <div className="hint" style={{ marginTop: 4 }}>
        Wipes localStorage. Goes back to the login screen.
      </div>
    </>
  );
}

function SeedButton({ spreadsheetId }: { spreadsheetId: string }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function seed(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const api = createSheetsAPI(spreadsheetId);
      const { created } = await seedConfigTabs(api);
      setResult(
        created.length
          ? `Created: ${created.join(', ')}. Open the sheet and edit the rules.`
          : 'All config tabs already exist — nothing changed.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        className="secondary"
        style={{ marginTop: 12 }}
        onClick={seed}
        disabled={busy}
      >
        {busy ? 'Seeding…' : 'Seed config tabs with defaults'}
      </button>
      {result && <div className="ok">{result}</div>}
      {error && <div className="error">{error}</div>}
    </>
  );
}

/** "https://docs.google.com/spreadsheets/d/<ID>/edit…" → ID. */
function extractSpreadsheetId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const match = trimmed.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (match?.[1]) return match[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) return trimmed;
  return '';
}
