import { useEffect, useState } from 'react';
import { isConfigured, loadSettings, type Settings } from './settings';
import { isSignedIn, onAuthLost, signInInteractive } from './google';
import { LoginScreen } from './Login';
import { SettingsScreen } from './SettingsScreen';
import { ImportScreen } from './Import';
import { RulesScreen } from './Rules';
import { ConfirmScreen } from './ConfirmScreen';
import { ReceiptScreen } from './ReceiptScreen';

type Tab = 'import' | 'rules' | 'confirm' | 'receipt' | 'settings';

export function App(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [tab, setTab] = useState<Tab>('import');
  const [signedIn, setSignedIn] = useState(isSignedIn());
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // A background token refresh that fails flips the banner on immediately,
  // wherever the user is.
  useEffect(() => {
    onAuthLost(() => setSignedIn(false));
    return () => onAuthLost(null);
  }, []);

  async function reconnect(): Promise<void> {
    setAuthBusy(true);
    setAuthError(null);
    try {
      await signInInteractive();
      setSignedIn(true);
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : String(e));
    } finally {
      setAuthBusy(false);
    }
  }

  // Re-check on every tab switch so an expiry that happened off-screen surfaces.
  function go(next: Tab): void {
    setSignedIn(isSignedIn());
    setTab(next);
  }

  if (!isConfigured(settings)) {
    return <LoginScreen onSaved={setSettings} />;
  }

  return (
    <>
      <div className="app">
        {!signedIn && (
          <div className="card" style={{ borderColor: 'var(--danger)' }}>
            <strong>Google session expired</strong>
            <p className="hint" style={{ marginTop: 4 }}>
              Reconnect to read or write your sheet.
            </p>
            <button
              className="primary"
              style={{ marginTop: 8 }}
              onClick={() => void reconnect()}
              disabled={authBusy}
            >
              {authBusy ? 'Connecting…' : 'Reconnect Google'}
            </button>
            {authError && <div className="error">{authError}</div>}
          </div>
        )}
        {tab === 'import' && <ImportScreen settings={settings} />}
        {tab === 'rules' && <RulesScreen settings={settings} />}
        {tab === 'confirm' && <ConfirmScreen settings={settings} />}
        {tab === 'receipt' && <ReceiptScreen settings={settings} />}
        {tab === 'settings' && <SettingsScreen settings={settings} onChanged={setSettings} />}
      </div>
      <nav className="tabs">
        <button className={tab === 'import' ? 'tab active' : 'tab'} onClick={() => go('import')}>
          Import
        </button>
        <button className={tab === 'rules' ? 'tab active' : 'tab'} onClick={() => go('rules')}>
          Rules
        </button>
        <button className={tab === 'confirm' ? 'tab active' : 'tab'} onClick={() => go('confirm')}>
          Confirm
        </button>
        <button className={tab === 'receipt' ? 'tab active' : 'tab'} onClick={() => go('receipt')}>
          Receipt
        </button>
        <button className={tab === 'settings' ? 'tab active' : 'tab'} onClick={() => go('settings')}>
          More
        </button>
      </nav>
    </>
  );
}
