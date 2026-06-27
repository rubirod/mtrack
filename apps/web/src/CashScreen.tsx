import { useEffect, useMemo, useState } from 'react';
import { appendManualOperation, type ClassifiedOperation, type SheetsAPI } from '@mtrack/core';
import type { Settings } from './settings';
import { createSheetsAPI } from './google';

/**
 * Cash tab — manual entry, the fast interactive path (never reads the whole
 * operations tab).
 *
 *  - Expense: pick a balance, amount, category, note → one expense op.
 *  - Balance adjustment: enter the balance you actually have; the app sums the
 *    current operations for that balance and appends one op for the difference
 *    (category "Balance adjustment"), the way Money Pro reconciles a balance.
 *
 * Idempotency is the user's job — the submit button disables while writing and
 * each op gets a unique sourceId.
 */

interface Props {
  settings: Settings;
}

interface Balance {
  name: string;
  currency: string;
}

type Mode = 'expense' | 'adjust';

const ADJUST_CATEGORY = 'Balance adjustment';

function today(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function looseNum(s: string): number {
  return parseFloat(String(s ?? '').replace(/\s/g, '').replace(',', '.'));
}

export function CashScreen({ settings }: Props): React.JSX.Element {
  const api = useMemo<SheetsAPI>(
    () => createSheetsAPI(settings.spreadsheetId),
    [settings.spreadsheetId],
  );

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const [balances, setBalances] = useState<Balance[]>([]);
  const [categories, setCategories] = useState<string[]>([]);

  const [mode, setMode] = useState<Mode>('expense');
  const [accountName, setAccountName] = useState('');
  const [currency, setCurrency] = useState('');
  const [date, setDate] = useState(today());

  // expense
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [note, setNote] = useState('');

  // adjust
  const [desired, setDesired] = useState('');
  const [current, setCurrent] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [balRows, catRows] = await Promise.all([
          api.getValues('balances!A2:B'),
          api.getValues('categories!A2:A'),
        ]);
        if (cancelled) return;
        const bals = balRows
          .map((r) => ({ name: String(r[0] ?? ''), currency: String(r[1] ?? '') }))
          .filter((b) => b.name);
        setBalances(bals);
        setCategories(catRows.map((r) => r[0]).filter((c): c is string => Boolean(c)));
        if (bals[0]) {
          setAccountName(bals[0].name);
          setCurrency(bals[0].currency);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  function pickBalance(name: string): void {
    setAccountName(name);
    const b = balances.find((x) => x.name === name);
    if (b?.currency) setCurrency(b.currency);
    setCurrent(null); // invalidate a previous adjustment calc
  }

  async function run(fn: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function addExpense(): Promise<void> {
    const amt = looseNum(amount);
    if (!accountName) return setError('Pick a balance first.');
    if (!Number.isFinite(amt) || amt <= 0) return setError('Enter a positive amount.');
    await run(async () => {
      const op: ClassifiedOperation = {
        date,
        time: null,
        account: null,
        amount: -Math.abs(amt),
        currency,
        bankCategory: '',
        mcc: null,
        description: note.trim(),
        kind: 'expense',
        category: category || null,
        counterparty: null,
        source: 'manual',
        needsConfirmation: !category,
        excluded: false,
        sourceId: `cash:${Date.now()}`,
      };
      await appendManualOperation(api, op, accountName, 'manual');
      setStatus(`Added ${amt} ${currency} on ${accountName}.`);
      setAmount('');
      setNote('');
    });
  }

  // Sums the existing operations for the picked balance so the adjustment can be
  // shown before it's written. Reads two columns only, not the whole row set.
  async function calcCurrent(): Promise<void> {
    if (!accountName) return setError('Pick a balance first.');
    await run(async () => {
      const [names, amounts] = await Promise.all([
        api.getValues('operations!D2:D'),
        api.getValues('operations!H2:H'),
      ]);
      let sum = 0;
      for (let i = 0; i < names.length; i++) {
        if ((names[i]?.[0] ?? '') === accountName) sum += looseNum(amounts[i]?.[0] ?? '') || 0;
      }
      setCurrent(sum);
      setStatus(null);
    });
  }

  const diff = current === null ? null : looseNum(desired) - current;

  async function applyAdjustment(): Promise<void> {
    if (current === null) return setError('Calculate the current balance first.');
    const want = looseNum(desired);
    if (!Number.isFinite(want)) return setError('Enter the desired balance.');
    const delta = want - current;
    if (Math.abs(delta) < 1e-9) return setError('Already at that balance — nothing to adjust.');
    await run(async () => {
      const op: ClassifiedOperation = {
        date,
        time: null,
        account: null,
        amount: delta,
        currency,
        bankCategory: '',
        mcc: null,
        description: ADJUST_CATEGORY,
        kind: delta >= 0 ? 'income' : 'expense',
        category: ADJUST_CATEGORY,
        counterparty: null,
        source: 'manual',
        needsConfirmation: false,
        excluded: false,
        sourceId: `adjust:${Date.now()}`,
      };
      await appendManualOperation(api, op, accountName, 'manual');
      setStatus(`Adjusted ${accountName} by ${delta.toFixed(2)} ${currency} → ${want}.`);
      setCurrent(want);
    });
  }

  return (
    <>
      <h1>Cash</h1>
      <div className="row" style={{ gap: 8 }}>
        <button
          className={mode === 'expense' ? 'primary' : 'secondary'}
          disabled={busy}
          onClick={() => setMode('expense')}
        >
          Expense
        </button>
        <button
          className={mode === 'adjust' ? 'primary' : 'secondary'}
          disabled={busy}
          onClick={() => setMode('adjust')}
        >
          Adjust balance
        </button>
      </div>

      <div className="card">
        <label htmlFor="balance">Balance</label>
        <select
          id="balance"
          value={accountName}
          disabled={busy || loading}
          onChange={(e) => pickBalance(e.target.value)}
        >
          {balances.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
            </option>
          ))}
        </select>
        <div className="row" style={{ marginTop: 8 }}>
          <div>
            <label htmlFor="date">Date</label>
            <input id="date" type="text" value={date} disabled={busy} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label htmlFor="cur">Currency</label>
            <input id="cur" type="text" value={currency} disabled={busy} onChange={(e) => setCurrency(e.target.value)} />
          </div>
        </div>
      </div>

      {mode === 'expense' ? (
        <div className="card">
          <label htmlFor="amount">Amount</label>
          <input
            id="amount"
            type="number"
            step="0.01"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            disabled={busy}
            onChange={(e) => setAmount(e.target.value)}
          />
          <label htmlFor="cat" style={{ marginTop: 8 }}>
            Category
          </label>
          <select id="cat" value={category} disabled={busy} onChange={(e) => setCategory(e.target.value)}>
            <option value="">— none (review in Confirm) —</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <label htmlFor="note" style={{ marginTop: 8 }}>
            Note
          </label>
          <input id="note" type="text" value={note} disabled={busy} onChange={(e) => setNote(e.target.value)} />
          <button className="primary" style={{ marginTop: 12 }} disabled={busy} onClick={() => void addExpense()}>
            {busy ? 'Working…' : 'Add expense'}
          </button>
        </div>
      ) : (
        <div className="card">
          <label htmlFor="desired">Desired balance</label>
          <input
            id="desired"
            type="number"
            step="0.01"
            inputMode="decimal"
            placeholder="actual amount you have"
            value={desired}
            disabled={busy}
            onChange={(e) => setDesired(e.target.value)}
          />
          <button className="secondary" style={{ marginTop: 8 }} disabled={busy} onClick={() => void calcCurrent()}>
            {busy ? 'Working…' : 'Calculate adjustment'}
          </button>
          {current !== null && (
            <div className="hint" style={{ marginTop: 8 }}>
              Current: {current.toFixed(2)} {currency}
              {diff !== null && Number.isFinite(diff) && (
                <>
                  {' '}
                  · adjust by <strong>{diff.toFixed(2)}</strong> {currency}
                </>
              )}
            </div>
          )}
          <button
            className="primary"
            style={{ marginTop: 12 }}
            disabled={busy || current === null}
            onClick={() => void applyAdjustment()}
          >
            {busy ? 'Working…' : 'Apply adjustment'}
          </button>
        </div>
      )}

      {status && <div className="ok">{status}</div>}
      {error && <div className="error">{error}</div>}
    </>
  );
}
