/**
 * Thin wrapper around Google Identity Services (GIS) plus REST calls to the
 * Sheets API via fetch. The Node `googleapis` SDK doesn't run in the browser.
 *
 * Token flow. GIS Token Client issues a short-lived (1 hour) access token in
 * the browser via popup or silent. Refresh — call the client again; safe
 * because the user is already signed into Google in the browser.
 *
 * Keeping the session alive. The token client ALWAYS opens a popup window,
 * even with `prompt: 'none'` — measured: without a user gesture it fails in
 * ~3ms with `popup_failed_to_open`. So a background timer cannot renew the
 * token, and the implicit flow has no refresh token (that would need a
 * backend holding the client secret). What does work is renewing *during* a
 * user gesture: inside a click, `prompt: 'none'` with a live Google session
 * returns a fresh token in under a second, asking nothing — the popup opens
 * and closes itself. `startTokenAutoRefresh` therefore tops the token up on
 * the user's own taps, well before it expires, so the "Reconnect" banner
 * stops appearing every hour. It's a best-effort renewal: if it fails the
 * app degrades to exactly the old behaviour (banner → interactive sign-in).
 *
 * The Google OAuth Client ID is baked into the build via
 * `VITE_GOOGLE_CLIENT_ID` (see `.env.example`). It is **public by design**:
 * the Authorized JavaScript origins on the OAuth client lock its usage to
 * the deployed PWA's domain. There is no Client Secret in the browser flow.
 */

import type { Row, SheetsAPI, ValueRange } from '@mtrack/core';

const GIS_SRC = 'https://accounts.google.com/gsi/client';

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
  // Listing the user's sheets to populate the picker; metadata only,
  // no content access.
  'https://www.googleapis.com/auth/drive.metadata.readonly',
].join(' ');

const CLIENT_ID: string = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? '';

export function isClientIdConfigured(): boolean {
  return CLIENT_ID.endsWith('.apps.googleusercontent.com');
}

function requireClientId(): string {
  if (!isClientIdConfigured()) {
    throw new Error(
      'VITE_GOOGLE_CLIENT_ID is not set at build time. Configure the OAuth Client ID in the build environment before deploying.',
    );
  }
  return CLIENT_ID;
}

let scriptLoad: Promise<void> | null = null;

function loadGisScript(): Promise<void> {
  if (scriptLoad) return scriptLoad;
  scriptLoad = new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${GIS_SRC}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load Google Identity Services'));
    document.head.appendChild(s);
  });
  return scriptLoad;
}

export interface AccessToken {
  token: string;
  expiresAt: number; // epoch ms
}

// Tokens are persisted in localStorage so a page reload within the 1-hour
// validity window doesn't re-open the OAuth popup. Same risk profile as the
// Anthropic key already living there — both are bearer tokens scoped to this
// device. On signOut we wipe both the in-memory cache and the stored copy.
// Bump the key suffix whenever SCOPES changes so old tokens (missing the
// new scopes) get discarded and the user re-consents.
const TOKEN_KEY = 'mtrack.google.token.v2';

// Survives token expiry: it records that this device has signed in at least
// once, so the gesture refresher stays quiet on a device that never has (a
// speculative popup on the login screen would be pure noise). Cleared only
// by an explicit sign-out.
const SESSION_KEY = 'mtrack.google.session.v1';

function markSession(): void {
  try {
    localStorage.setItem(SESSION_KEY, '1');
  } catch {
    /* ignore */
  }
}

function hasSession(): boolean {
  try {
    return localStorage.getItem(SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

function readStoredToken(): AccessToken | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AccessToken;
    if (!parsed.token || !parsed.expiresAt) return null;
    if (Date.now() > parsed.expiresAt - 30_000) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredToken(t: AccessToken): void {
  markSession();
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
  } catch {
    // localStorage quota or private mode — fall back to memory only.
  }
}

function clearStoredToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

let cached: AccessToken | null = readStoredToken();

// Deduplicate concurrent token requests. When a page makes several Sheets
// calls in parallel (e.g. Rules tab reads 6 tabs at once), they would each
// spawn their own OAuth popup; browsers block all but the first, leaving
// the rest hanging forever. With this guard they all await one shared flow.
let inflight: Promise<AccessToken> | null = null;

export function currentToken(): AccessToken | null {
  if (!cached) cached = readStoredToken();
  if (!cached) return null;
  if (Date.now() > cached.expiresAt - 30_000) {
    cached = null;
    clearStoredToken();
    return null;
  }
  return cached;
}

/** Thrown when no valid token is cached and a silent refresh can't get one
 *  without user interaction — the caller should prompt an interactive sign-in. */
export class NeedsReauthError extends Error {
  constructor() {
    super('Google sign-in required');
    this.name = 'NeedsReauthError';
  }
}

// The app subscribes here so it can surface a "Reconnect" prompt the moment a
// background token refresh fails — and clear it again when one succeeds —
// without every screen having to handle it.
let authLost: (() => void) | null = null;
export function onAuthLost(fn: (() => void) | null): void {
  authLost = fn;
}

let authRestored: (() => void) | null = null;
export function onAuthRestored(fn: (() => void) | null): void {
  authRestored = fn;
}

/** True when a non-expired token is cached. */
export function isSignedIn(): boolean {
  return currentToken() !== null;
}

/**
 * Requests a token from GIS. `prompt='none'` asks for no interaction: with a
 * live Google session and prior consent it resolves in well under a second,
 * and the popup it opens closes itself. `prompt='consent'` always shows the
 * account/consent screen. Both need a user gesture for the popup to open at
 * all — without one, `error_callback` reports `popup_failed_to_open`.
 */
function requestToken(prompt: 'none' | 'consent'): Promise<AccessToken> {
  const clientId = requireClientId();
  return loadGisScript().then(
    () =>
      new Promise<AccessToken>((resolve, reject) => {
        const client = google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: SCOPES,
          callback: (resp) => {
            if (resp.error) {
              reject(new Error(`Google OAuth error: ${resp.error}`));
              return;
            }
            const expiresIn = Number(resp.expires_in ?? 3600);
            cached = { token: resp.access_token, expiresAt: Date.now() + expiresIn * 1000 };
            writeStoredToken(cached);
            resolve(cached);
          },
          // Popup blocked, closed, or otherwise unusable. Without this the
          // promise would never settle and every caller would sit on the
          // timeout below.
          error_callback: (err) => reject(new Error(`Google OAuth: ${err.type}`)),
        });
        client.requestAccessToken({ prompt });
      }),
  );
}

/** Renew this long before expiry, whenever the user happens to interact. */
const REFRESH_MARGIN_MS = 10 * 60_000;
/** Two gesture-driven renewals are never fired closer together than this. */
const REFRESH_COOLDOWN_MS = 60_000;

let lastRefreshAttempt = 0;
let autoRefreshInstalled = false;

function onUserGesture(): void {
  if (!hasSession() || inflight) return;
  const t = currentToken();
  if (t && t.expiresAt - Date.now() > REFRESH_MARGIN_MS) return;
  const now = Date.now();
  if (now - lastRefreshAttempt < REFRESH_COOLDOWN_MS) return;
  lastRefreshAttempt = now;
  // Fire and forget — we're inside the gesture, so the popup may open, and
  // with prompt 'none' it asks nothing. A failure is not proof the session is
  // dead (an extension may have blocked the popup), so it stays silent: the
  // banner is still raised by the first real call that can't get a token.
  requestToken('none').then(
    () => {
      if (authRestored) authRestored();
    },
    () => {},
  );
}

/**
 * Starts renewing the access token on the user's own taps. Idempotent; call
 * once at app start. Listeners are in the capture phase so a handler that
 * stops propagation can't suppress the renewal.
 */
export function startTokenAutoRefresh(): void {
  if (autoRefreshInstalled) return;
  autoRefreshInstalled = true;
  document.addEventListener('pointerdown', onUserGesture, true);
  document.addEventListener('keydown', onUserGesture, true);
}

export async function getAccessToken(): Promise<AccessToken> {
  const t = currentToken();
  if (t) return t;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      // No-interaction refresh. It succeeds only when this call happens to sit
      // inside a user gesture and the Google session is live; otherwise
      // `error_callback` rejects almost immediately and the caller is told to
      // sign in interactively. The timeout is a backstop for a GIS that
      // neither calls back nor errors.
      const silent = requestToken('none');
      silent.catch(() => {}); // swallow late rejection if the timeout wins
      const tok = await Promise.race([
        silent,
        new Promise<AccessToken>((_, reject) =>
          setTimeout(() => reject(new NeedsReauthError()), 4000),
        ),
      ]);
      if (authRestored) authRestored();
      return tok;
    } catch (e) {
      if (authLost) authLost();
      throw e;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Interactive sign-in. Opens the consent popup, so it MUST be called from a
 * user gesture (button click) or the browser blocks the popup. This is the
 * recovery path when `getAccessToken` reports `NeedsReauthError`.
 */
export async function signInInteractive(): Promise<AccessToken> {
  const tok = await requestToken('consent');
  if (authRestored) authRestored();
  return tok;
}

export function signOut(): void {
  cached = null;
  clearStoredToken();
  clearSession();
}

async function sheetsFetch(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sheets API ${res.status}: ${body}`);
  }
  return res.json();
}

export interface SpreadsheetMeta {
  id: string;
  title: string;
}

export async function getSpreadsheetMeta(spreadsheetId: string): Promise<SpreadsheetMeta> {
  const { token } = await getAccessToken();
  const data = (await sheetsFetch(
    token,
    `/${encodeURIComponent(spreadsheetId)}?fields=properties.title`,
  )) as { properties: { title: string } };
  return { id: spreadsheetId, title: data.properties.title };
}

/**
 * Lists the user's Google Sheets via Drive API, most-recently-modified first.
 * Used by the Settings picker so the user doesn't have to paste a URL.
 * Requires the `drive.metadata.readonly` scope.
 */
export async function listSpreadsheets(): Promise<SpreadsheetMeta[]> {
  const { token } = await getAccessToken();
  const params = new URLSearchParams({
    q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
    fields: 'files(id,name)',
    orderBy: 'modifiedTime desc',
    pageSize: '50',
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Drive list ${res.status}: ${body}`);
  }
  const data = (await res.json()) as { files?: Array<{ id: string; name: string }> };
  return (data.files ?? []).map((f) => ({ id: f.id, title: f.name }));
}

/** SheetsAPI implementation on top of Google REST. */
export function createSheetsAPI(spreadsheetId: string): SheetsAPI {
  const path = (suffix: string): string => `/${encodeURIComponent(spreadsheetId)}${suffix}`;

  return {
    async getValues(range: string): Promise<string[][]> {
      const { token } = await getAccessToken();
      const data = (await sheetsFetch(token, `${path(`/values/${encodeURIComponent(range)}`)}`)) as {
        values?: string[][];
      };
      return data.values ?? [];
    },

    async updateValues(range: string, values: Row[]): Promise<void> {
      const { token } = await getAccessToken();
      await sheetsFetch(
        token,
        `${path(`/values/${encodeURIComponent(range)}?valueInputOption=RAW`)}`,
        { method: 'PUT', body: JSON.stringify({ values }) },
      );
    },

    async appendValues(range: string, values: Row[]): Promise<void> {
      const { token } = await getAccessToken();
      await sheetsFetch(
        token,
        `${path(`/values/${encodeURIComponent(range)}:append?valueInputOption=RAW`)}`,
        { method: 'POST', body: JSON.stringify({ values }) },
      );
    },

    async batchUpdateValues(data: ValueRange[]): Promise<void> {
      const { token } = await getAccessToken();
      await sheetsFetch(token, `${path('/values:batchUpdate')}`, {
        method: 'POST',
        body: JSON.stringify({ valueInputOption: 'RAW', data }),
      });
    },

    async listTabs(): Promise<string[]> {
      const { token } = await getAccessToken();
      const data = (await sheetsFetch(token, `${path('?fields=sheets.properties.title')}`)) as {
        sheets?: { properties: { title: string } }[];
      };
      return (data.sheets ?? []).map((s) => s.properties.title);
    },

    async ensureTab(title: string): Promise<void> {
      const { token } = await getAccessToken();
      await sheetsFetch(token, `${path(':batchUpdate')}`, {
        method: 'POST',
        body: JSON.stringify({
          requests: [{ addSheet: { properties: { title } } }],
        }),
      });
    },

    async clearRange(range: string): Promise<void> {
      const { token } = await getAccessToken();
      await sheetsFetch(
        token,
        `${path(`/values/${encodeURIComponent(range)}:clear`)}`,
        { method: 'POST', body: '{}' },
      );
    },
  };
}
