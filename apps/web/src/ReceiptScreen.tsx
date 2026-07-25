import { useEffect, useMemo, useState } from 'react';
import { appendManualOperations, type ClassifiedOperation, type SheetsAPI } from '@mtrack/core';
import type { Settings } from './settings';
import {
  buildCategoryTree,
  CategoryOptions,
  EMPTY_TREE,
  type CategoryTree,
} from './category-tree';
import { createSheetsAPI } from './google';
import { parseReceipt, type ImageMediaType, type ReceiptItem } from './ai';

/**
 * Receipt tab — Layer 3.
 *
 * Photograph a shop receipt → Claude vision splits it into per-item lines, each
 * pre-assigned a category from the user's list → the user reviews/edits → every
 * item lands as its own `operations` row via the fast append path (no full-tab
 * read). All items share the picked balance, date and currency; each gets a
 * unique sourceId so re-submitting can't silently duplicate.
 */

interface Props {
  settings: Settings;
}

interface Balance {
  name: string;
  currency: string;
}

interface Line extends ReceiptItem {
  include: boolean;
}

const ALLOWED_MEDIA: ImageMediaType[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function today(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function fileToBase64(file: File): Promise<{ data: string; mediaType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the image file'));
    reader.onload = () => {
      const url = String(reader.result);
      resolve({ data: url.slice(url.indexOf(',') + 1), mediaType: file.type });
    };
    reader.readAsDataURL(file);
  });
}

export function ReceiptScreen({ settings }: Props): React.JSX.Element {
  const api = useMemo<SheetsAPI>(
    () => createSheetsAPI(settings.spreadsheetId),
    [settings.spreadsheetId],
  );

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const [balances, setBalances] = useState<Balance[]>([]);
  const [categories, setCategories] = useState<CategoryTree>(EMPTY_TREE);

  const [accountName, setAccountName] = useState('');
  const [currency, setCurrency] = useState('');
  const [date, setDate] = useState(today());
  const [merchant, setMerchant] = useState('');
  const [lines, setLines] = useState<Line[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [balRows, catRows] = await Promise.all([
          api.getValues('balances!A2:B'),
          api.getValues('categories!A2:B'),
        ]);
        if (cancelled) return;
        const bals = balRows
          .map((r) => ({ name: String(r[0] ?? ''), currency: String(r[1] ?? '') }))
          .filter((b) => b.name);
        setBalances(bals);
        setCategories(buildCategoryTree(catRows));
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
  }

  async function handleFile(file: File): Promise<void> {
    setError(null);
    setStatus(null);
    setLines([]);
    setBusy(true);
    try {
      if (!settings.anthropicKey) throw new Error('Add an Anthropic key in More first.');
      const { data, mediaType } = await fileToBase64(file);
      if (!ALLOWED_MEDIA.includes(mediaType as ImageMediaType)) {
        throw new Error(`Unsupported image type: ${mediaType || 'unknown'}`);
      }
      setStatus('Reading the receipt…');
      const r = await parseReceipt(
        settings.anthropicKey,
        data,
        mediaType as ImageMediaType,
        categories.leaves,
      );
      setMerchant(r.merchant);
      if (r.date) setDate(r.date);
      if (r.currency) setCurrency(r.currency);
      setLines(r.items.map((it) => ({ ...it, include: true })));
      setStatus(
        r.items.length ? `Found ${r.items.length} items. Review below.` : 'No line items found.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function setLine(i: number, patch: Partial<Line>): void {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  const included = lines.filter((l) => l.include);
  const total = included.reduce((s, l) => s + (Number(l.amount) || 0), 0);

  async function submit(): Promise<void> {
    if (!accountName) {
      setError('Pick a balance first.');
      return;
    }
    if (included.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const ts = Date.now();
      const ops: ClassifiedOperation[] = included.map((l, i) => ({
        date,
        time: null,
        account: null,
        amount: -Math.abs(Number(l.amount) || 0),
        currency,
        bankCategory: '',
        mcc: null,
        description: merchant ? `${merchant} — ${l.description}` : l.description,
        kind: 'expense',
        category: l.category || null,
        counterparty: null,
        source: 'ai',
        needsConfirmation: !l.category, // unsure category → surfaces in Confirm
        excluded: false,
        sourceId: `receipt:${ts}:${i}`,
      }));
      const n = await appendManualOperations(api, ops, accountName, 'receipt');
      setStatus(`Added ${n} operations to ${accountName}.`);
      setLines([]);
      setMerchant('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Receipt</h1>
      <p className="muted">
        Photograph a receipt — Claude splits it into items, each as its own
        operation on the balance you pick.
      </p>

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
        <label htmlFor="photo" style={{ marginTop: 8 }}>
          Receipt photo
        </label>
        <input
          id="photo"
          type="file"
          accept="image/*"
          capture="environment"
          disabled={busy || loading}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
        />
        <div className="hint">Sent to Claude vision with your category list. Nothing is stored.</div>
      </div>

      {lines.length > 0 && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h2 style={{ margin: 0 }}>{merchant || 'Items'}</h2>
            <span className="muted">
              {included.length} · {total.toFixed(2)} {currency}
            </span>
          </div>
          <table className="rules">
            <thead>
              <tr>
                <th>add</th>
                <th>item</th>
                <th>amount</th>
                <th>category</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td>
                    <input
                      type="checkbox"
                      checked={l.include}
                      disabled={busy}
                      onChange={(e) => setLine(i, { include: e.target.checked })}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      value={l.description}
                      disabled={busy}
                      onChange={(e) => setLine(i, { description: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      step="0.01"
                      value={l.amount}
                      disabled={busy}
                      style={{ width: 90 }}
                      onChange={(e) => setLine(i, { amount: Number(e.target.value) })}
                    />
                  </td>
                  <td>
                    <select
                      value={l.category}
                      disabled={busy}
                      onChange={(e) => setLine(i, { category: e.target.value })}
                    >
                      <option value="">— none —</option>
                      <CategoryOptions tree={categories} />
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="primary" disabled={busy || included.length === 0} onClick={() => void submit()}>
            {busy ? 'Working…' : `Add ${included.length} operations`}
          </button>
        </div>
      )}

      {status && <div className="ok">{status}</div>}
      {error && <div className="error">{error}</div>}
    </>
  );
}
