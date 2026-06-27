/**
 * Thin wrapper around Google Identity Services (GIS) plus REST calls to the
 * Sheets API via fetch. The Node `googleapis` SDK doesn't run in the browser.
 *
 * Token flow. GIS Token Client issues a short-lived (1 hour) access token in
 * the browser via popup or silent. Refresh — call the client again; safe
 * because the user is already signed into Google in the browser.
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
// background token refresh fails, without every screen having to handle it.
let authLost: (() => void) | null = null;
export function onAuthLost(fn: (() => void) | null): void {
  authLost = fn;
}

/** True when a non-expired token is cached. */
export function isSignedIn(): boolean {
  return currentToken() !== null;
}

/**
 * Requests a token from GIS. `prompt=''` is a silent refresh (uses the existing
 * Google session via a hidden iframe); `prompt='consent'` always opens the
 * account/consent popup and so must be called from a user gesture.
 */
function requestToken(prompt: '' | 'consent'): Promise<AccessToken> {
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
        });
        client.requestAccessToken({ prompt });
      }),
  );
}

export async function getAccessToken(): Promise<AccessToken> {
  const t = currentToken();
  if (t) return t;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      // Silent refresh, but bounded: GIS never calls back when it silently
      // needs a popup it can't open (no gesture, or blocked third-party
      // cookies), which used to hang the whole screen. Time out and signal
      // that an interactive sign-in is required instead.
      const silent = requestToken('');
      silent.catch(() => {}); // swallow late rejection if the timeout wins
      return await Promise.race([
        silent,
        new Promise<AccessToken>((_, reject) =>
          setTimeout(() => reject(new NeedsReauthError()), 4000),
        ),
      ]);
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
  return requestToken('consent');
}

export function signOut(): void {
  cached = null;
  clearStoredToken();
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
