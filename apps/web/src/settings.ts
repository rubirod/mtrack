/**
 * Per-user settings, stored in localStorage on the user's device.
 *
 * The Google OAuth Client ID lives in the build (set via
 * `VITE_GOOGLE_CLIENT_ID` at build time) — see `google.ts`. Per-user
 * settings carry only the bits that are genuinely per-user: the Anthropic
 * key (paid by the user) and the spreadsheet they own.
 */

const KEY = 'mtrack.settings.v1';

export interface Settings {
  anthropicKey: string;
  spreadsheetId: string;
  spreadsheetName: string;
}

export const EMPTY_SETTINGS: Settings = {
  anthropicKey: '',
  spreadsheetId: '',
  spreadsheetName: '',
};

export function loadSettings(): Settings {
  const raw = localStorage.getItem(KEY);
  if (!raw) return EMPTY_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...EMPTY_SETTINGS, ...parsed };
  } catch {
    return EMPTY_SETTINGS;
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function isConfigured(s: Settings): boolean {
  return Boolean(s.anthropicKey && s.spreadsheetId);
}
