import { useState } from 'react';
import { isConfigured, loadSettings, type Settings } from './settings';
import { LoginScreen } from './Login';
import { SettingsScreen } from './SettingsScreen';
import { ImportScreen } from './Import';
import { RulesScreen } from './Rules';

type Tab = 'import' | 'rules' | 'confirm' | 'receipt' | 'settings';

export function App(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [tab, setTab] = useState<Tab>('import');

  if (!isConfigured(settings)) {
    return <LoginScreen onSaved={setSettings} />;
  }

  return (
    <>
      <div className="app">
        {tab === 'import' && <ImportScreen settings={settings} />}
        {tab === 'rules' && <RulesScreen settings={settings} />}
        {tab === 'confirm' && <ConfirmPlaceholder />}
        {tab === 'receipt' && <ReceiptPlaceholder />}
        {tab === 'settings' && <SettingsScreen settings={settings} onChanged={setSettings} />}
      </div>
      <nav className="tabs">
        <button className={tab === 'import' ? 'tab active' : 'tab'} onClick={() => setTab('import')}>
          Import
        </button>
        <button className={tab === 'rules' ? 'tab active' : 'tab'} onClick={() => setTab('rules')}>
          Rules
        </button>
        <button className={tab === 'confirm' ? 'tab active' : 'tab'} onClick={() => setTab('confirm')}>
          Confirm
        </button>
        <button className={tab === 'receipt' ? 'tab active' : 'tab'} onClick={() => setTab('receipt')}>
          Receipt
        </button>
        <button className={tab === 'settings' ? 'tab active' : 'tab'} onClick={() => setTab('settings')}>
          More
        </button>
      </nav>
    </>
  );
}

function ConfirmPlaceholder(): React.JSX.Element {
  return (
    <>
      <h1>Confirm</h1>
      <p className="muted">
        Feed of operations with needsConfirmation=TRUE: rules that suggested a
        category but want a tap. Pick the category, push back to the sheet,
        flag manualOverride.
      </p>
      <div className="card">
        <em className="muted">TODO: load operations!A:S, filter needsConfirmation=TRUE.</em>
      </div>
    </>
  );
}

function ReceiptPlaceholder(): React.JSX.Element {
  return (
    <>
      <h1>Receipt</h1>
      <p className="muted">
        Photo of a receipt → Claude vision → line items with categories.
        Each item lands as its own row in operations.
      </p>
      <div className="card">
        <em className="muted">TODO: capture + Claude vision call.</em>
      </div>
    </>
  );
}
