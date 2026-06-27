import { useState } from 'react';
import type { Settings } from './settings';
import { saveSettings } from './settings';
import {
  getSpreadsheetMeta,
  isClientIdConfigured,
  listSpreadsheets,
  signInInteractive,
  type SpreadsheetMeta,
} from './google';

interface Props {
  onSaved: (s: Settings) => void;
}

/**
 * First-launch gate. Shown until `isConfigured(settings)` becomes true.
 *
 * Three steps:
 *  1. Paste Anthropic API key.
 *  2. Sign in to Google (one popup, three scopes).
 *  3. Pick a spreadsheet from the dropdown of the user's sheets, or paste a
 *     URL for sheets shared by link.
 *
 * On Save the settings are persisted and the parent navigates to the main
 * tab layout. After this screen, every other tab can rely on a fully
 * configured `Settings` object.
 */
export function LoginScreen({ onSaved }: Props): React.JSX.Element {
  const [anthropicKey, setAnthropicKey] = useState('');
  const [sheets, setSheets] = useState<SpreadsheetMeta[] | null>(null);
  const [picked, setPicked] = useState<SpreadsheetMeta | null>(null);
  const [pasteInput, setPasteInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clientIdConfigured = isClientIdConfigured();
  const signedIn = sheets !== null;

  async function signInAndList(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      await signInInteractive();
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
      if (!id) throw new Error('Cannot extract a spreadsheet ID from that input');
      const meta = await getSpreadsheetMeta(id);
      setPicked(meta);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function save(): void {
    setError(null);
    if (!anthropicKey.startsWith('sk-ant-')) {
      setError('Anthropic key must start with "sk-ant-"');
      return;
    }
    if (!picked) {
      setError('Pick a spreadsheet first');
      return;
    }
    const next: Settings = {
      anthropicKey,
      spreadsheetId: picked.id,
      spreadsheetName: picked.title,
    };
    saveSettings(next);
    onSaved(next);
  }

  return (
    <div className="app">
      <h1>Welcome to mtrack</h1>
      <p className="hint">
        Set up access to your Anthropic API key and Google spreadsheet to get started.
        Both values stay on this device — they're not sent anywhere except Anthropic and Google.
      </p>

      {!clientIdConfigured && (
        <div className="error" style={{ marginBottom: 16 }}>
          This build has no Google OAuth Client ID. The deploy maintainer must
          set <code>VITE_GOOGLE_CLIENT_ID</code> and redeploy.
        </div>
      )}

      <h2>1. Anthropic API key</h2>
      <div className="field">
        <input
          type="password"
          autoComplete="off"
          placeholder="sk-ant-…"
          value={anthropicKey}
          onChange={(e) => setAnthropicKey(e.target.value)}
        />
        <div className="hint">
          From{' '}
          <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
            console.anthropic.com
          </a>
          . Needs Messages and Vision permissions.
        </div>
      </div>

      <h2>2. Google account</h2>
      {!signedIn ? (
        <button
          className="primary"
          onClick={signInAndList}
          disabled={busy || !clientIdConfigured}
        >
          {busy ? 'Signing in…' : 'Sign in to Google'}
        </button>
      ) : (
        <p className="ok">Signed in · {sheets!.length} spreadsheets visible</p>
      )}

      {signedIn && (
        <>
          <h2>3. Spreadsheet</h2>
          <div className="field">
            <label htmlFor="pick">Pick from your sheets</label>
            <select
              id="pick"
              value={picked?.id ?? ''}
              onChange={(e) => {
                const found = sheets!.find((s) => s.id === e.target.value);
                setPicked(found ?? null);
              }}
            >
              <option value="">— pick a sheet —</option>
              {sheets!.map((s) => (
                <option key={s.id} value={s.id}>{s.title}</option>
              ))}
            </select>
            <div className="hint">Most-recently-modified first.</div>
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

          {picked && (
            <div className="ok" style={{ marginTop: 12 }}>
              Selected: <strong>{picked.title}</strong>
            </div>
          )}
        </>
      )}

      {error && <div className="error">{error}</div>}

      {signedIn && (
        <button
          className="primary"
          style={{ marginTop: 16 }}
          onClick={save}
          disabled={busy || !picked || !anthropicKey}
        >
          Save and enter
        </button>
      )}
    </div>
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
