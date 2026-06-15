import { useEffect, useMemo, useState } from 'react';
import {
  assertWritableTab,
  loadClassifyConfig,
  reclassifyAll,
  type Row,
  type SheetsAPI,
} from '@mtrack/core';
import type { Settings } from './settings';
import { createSheetsAPI } from './google';
import { clusterMerchant } from './merchants';

/**
 * Rules tab — data-driven editor for balances, instrument routing,
 * bank-category mappings, and merchant-level overrides.
 *
 * Discovers distinct values from `operations` and presents them next to
 * the current config. Saving rewrites the corresponding tab; "Apply now"
 * re-classifies existing rows so new mappings show up without re-importing
 * statements.
 *
 * Merchant breakdown: each bank category can be expanded inline to show its
 * distinct merchants (clustered via `clusterMerchant`). Picking a category
 * for a merchant writes a `merchant_rules` row that overrides the default
 * `bank_category_map` mapping for ops matching that merchant string.
 */

interface Props {
  settings: Settings;
}

interface BalanceEntry {
  name: string;
  currency: string;
  type: string;
  archived: boolean;
}

interface AccountEntry {
  sourceChannel: string;
  tail: string;
  count: number;
  balance: string;
}

interface MerchantEntry {
  merchant: string;
  count: number;
  /**
   * Encoded existing rule, if a merchant_rules row or counterparty_rules row
   * already matches this merchant via substring. Displayed under the merchant
   * name as a hint of current behaviour. Format same as `picked`.
   */
  existingMatch: string | null;
  existingPicked: string;
  /**
   * Encoded action picked in the UI. Empty = fall through to bank_category_map.
   * Encodings:
   *   "exp:<category>"  — expense, write merchant_rules row.
   *   "trf:<balance>"   — transfer, write counterparty_rules with label=balance.
   *   "peer"            — peer transfer, counterparty_rules label=merchant.
   *   "inc"             — income, counterparty_rules label=merchant.
   */
  picked: string;
}

interface CounterpartyRuleRow {
  match: string;
  kind: 'transfer' | 'income' | 'peer';
  label: string;
  category: string;
  suggest: string;
  excluded: string;
  field: string;
}

interface BankCategoryEntry {
  bankCategory: string;
  count: number;
  category: string;
  merchants: MerchantEntry[];
}

interface MerchantRuleRow {
  match: string;
  category: string;
}

const BALANCES_HEADERS = ['name', 'currency', 'type', 'archived'];
const ACCOUNTS_HEADERS = ['sourceChannel', 'tail', 'balance'];
const BANK_MAP_HEADERS = ['bankCategory', 'category'];
const MERCHANT_HEADERS = ['match', 'category'];
const CP_HEADERS = ['match', 'kind', 'label', 'category', 'suggest', 'excluded', 'field'];

export function RulesScreen({ settings }: Props): React.JSX.Element {
  const api = useMemo(
    () => createSheetsAPI(settings.spreadsheetId),
    [settings.spreadsheetId],
  );

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [balances, setBalances] = useState<BalanceEntry[]>([]);
  const [accounts, setAccounts] = useState<AccountEntry[]>([]);
  const [bankCats, setBankCats] = useState<BankCategoryEntry[]>([]);
  const [existingMerchantRules, setExistingMerchantRules] = useState<MerchantRuleRow[]>([]);
  const [existingCpRules, setExistingCpRules] = useState<CounterpartyRuleRow[]>([]);
  const [categories, setCategories] = useState<string[]>([]);

  useEffect(() => {
    void load();
  }, [api]);

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const [opsRows, balanceRows, accountsRows, bankMapRows, merchantRows, cpRows, categoryRows] =
        await Promise.all([
          safeRead(api, 'operations!A2:S'),
          safeRead(api, 'balances!A2:D'),
          safeRead(api, 'accounts!A2:C'),
          safeRead(api, 'bank_category_map!A2:B'),
          safeRead(api, 'merchant_rules!A2:B'),
          safeRead(api, 'counterparty_rules!A2:G'),
          safeRead(api, 'categories!A2:A'),
        ]);

      const categoryList: string[] = [];
      for (const r of categoryRows) {
        const v = r[0];
        if (v) categoryList.push(v);
      }
      setCategories(categoryList);

      const balanceList: BalanceEntry[] = [];
      for (const r of balanceRows) {
        if (!r[0]) continue;
        balanceList.push({
          name: r[0],
          currency: r[1] ?? '',
          type: r[2] ?? '',
          archived: (r[3] ?? '').toLowerCase() === 'true',
        });
      }
      setBalances(balanceList);

      const routingMap = new Map<string, string>();
      for (const row of accountsRows) {
        const [sc, tail, balance] = row;
        if (!sc) continue;
        routingMap.set(`${sc}|${tail ?? ''}`, balance ?? '');
      }

      const accountCounts = new Map<string, AccountEntry>();
      for (const row of opsRows) {
        const sourceChannel = String(row[16] ?? '');
        const tail = String(row[2] ?? '');
        if (!sourceChannel) continue;
        const key = `${sourceChannel}|${tail}`;
        const existing = accountCounts.get(key);
        if (existing) {
          existing.count++;
        } else {
          accountCounts.set(key, {
            sourceChannel,
            tail,
            count: 1,
            balance: routingMap.get(key) ?? '',
          });
        }
      }
      setAccounts([...accountCounts.values()].sort((a, b) => b.count - a.count));

      const bankMap = new Map<string, string>();
      for (const row of bankMapRows) {
        const [bank, cat] = row;
        if (bank) bankMap.set(bank, cat ?? '');
      }

      const merchantRules: MerchantRuleRow[] = [];
      for (const row of merchantRows) {
        const [match, category] = row;
        if (match) merchantRules.push({ match, category: category ?? '' });
      }
      setExistingMerchantRules(merchantRules);

      const cpRules: CounterpartyRuleRow[] = [];
      for (const row of cpRows) {
        const [match, kind, label, category, suggest, excluded, field] = row;
        if (!match || !kind || !label) continue;
        if (kind !== 'transfer' && kind !== 'income' && kind !== 'peer') continue;
        cpRules.push({
          match,
          kind,
          label,
          category: category ?? '',
          suggest: suggest ?? '',
          excluded: excluded ?? '',
          field: field ?? 'description',
        });
      }
      setExistingCpRules(cpRules);

      // Build merchant breakdown per bank category.
      const merchantsByBank = new Map<string, Map<string, MerchantEntry>>();
      const bankCounts = new Map<string, BankCategoryEntry>();

      for (const row of opsRows) {
        const bc = String(row[10] ?? '').trim();
        if (!bc) continue;
        const description = String(row[9] ?? '');
        const merchantKey = clusterMerchant(description);
        if (!merchantKey) continue;

        let group = merchantsByBank.get(bc);
        if (!group) {
          group = new Map();
          merchantsByBank.set(bc, group);
        }
        const existing = group.get(merchantKey);
        if (existing) {
          existing.count++;
        } else {
          // Find existing rule covering this merchant (substring match).
          // Counterparty rules take precedence over merchant rules (same
          // order as the classifier).
          const merchantLower = merchantKey.toLowerCase();
          let existingMatch: string | null = null;
          let existingPicked = '';

          for (const r of cpRules) {
            if (r.field !== 'description') continue;
            if (merchantLower.includes(r.match.toLowerCase())) {
              existingMatch = r.match;
              if (r.kind === 'transfer') existingPicked = `trf:${r.label}`;
              else if (r.kind === 'peer') existingPicked = 'peer';
              else if (r.kind === 'income') existingPicked = 'inc';
              break;
            }
          }
          if (!existingMatch) {
            for (const r of merchantRules) {
              if (merchantLower.includes(r.match.toLowerCase())) {
                existingMatch = r.match;
                existingPicked = `exp:${r.category}`;
                break;
              }
            }
          }

          group.set(merchantKey, {
            merchant: merchantKey,
            count: 1,
            existingMatch,
            existingPicked,
            picked: existingPicked,
          });
        }

        const bankEntry = bankCounts.get(bc);
        if (bankEntry) {
          bankEntry.count++;
        } else {
          bankCounts.set(bc, {
            bankCategory: bc,
            count: 1,
            category: bankMap.get(bc) ?? '',
            merchants: [],
          });
        }
      }

      // Attach sorted merchant lists.
      for (const [bc, entry] of bankCounts) {
        const merchants = [...(merchantsByBank.get(bc)?.values() ?? [])].sort(
          (a, b) => b.count - a.count,
        );
        entry.merchants = merchants;
      }

      setBankCats(
        [...bankCounts.values()].sort((a, b) => {
          if (!a.category && b.category) return -1;
          if (a.category && !b.category) return 1;
          return b.count - a.count;
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function saveBalances(): Promise<void> {
    await withBusy(async () => {
      const rows = balances
        .filter((b) => b.name.trim())
        .map((b) => [b.name.trim(), b.currency.trim(), b.type.trim(), b.archived ? 'TRUE' : ''] as Row);
      await rewriteTab(api, 'balances', BALANCES_HEADERS, rows);
      setStatus(`Saved ${rows.length} balances.`);
    });
  }

  async function saveAccounts(): Promise<void> {
    await withBusy(async () => {
      const rows = accounts
        .filter((a) => a.balance.trim())
        .map((a) => [a.sourceChannel, a.tail, a.balance.trim()] as Row);
      await rewriteTab(api, 'accounts', ACCOUNTS_HEADERS, rows);
      setStatus(`Routed ${rows.length} instruments to balances.`);
    });
  }

  async function saveBankCategories(): Promise<void> {
    await withBusy(async () => {
      const rows = bankCats
        .filter((b) => b.category.trim())
        .map((b) => [b.bankCategory, b.category.trim()] as Row);
      await rewriteTab(api, 'bank_category_map', BANK_MAP_HEADERS, rows);
      setStatus(`Saved ${rows.length} bank-category mappings.`);
    });
  }

  async function saveOverrides(): Promise<void> {
    await withBusy(async () => {
      // The merchant breakdown writes to two sheets:
      //   merchant_rules        for `exp:<category>` picks.
      //   counterparty_rules    for `trf:<balance>`, `peer`, `inc` picks.
      // Pre-existing rules untouched by the UI stay as-is — we upsert by
      // exact match string in each sheet.
      const merchantMap = new Map<string, string>();
      for (const r of existingMerchantRules) merchantMap.set(r.match, r.category);

      const cpMap = new Map<string, CounterpartyRuleRow>();
      for (const r of existingCpRules) cpMap.set(r.match, r);

      let touched = 0;
      for (const bc of bankCats) {
        for (const m of bc.merchants) {
          const picked = m.picked.trim();
          if (!picked) continue;
          if (picked === m.existingPicked) continue;
          touched++;

          if (picked.startsWith('exp:')) {
            const category = picked.slice(4);
            merchantMap.set(m.merchant, category);
            // If a counterparty rule with the same match was used before,
            // remove it so the merchant_rule takes effect cleanly.
            cpMap.delete(m.merchant);
          } else if (picked.startsWith('trf:')) {
            const label = picked.slice(4);
            cpMap.set(m.merchant, {
              match: m.merchant,
              kind: 'transfer',
              label,
              category: '',
              suggest: '',
              excluded: '',
              field: 'description',
            });
            merchantMap.delete(m.merchant);
          } else if (picked === 'peer') {
            cpMap.set(m.merchant, {
              match: m.merchant,
              kind: 'peer',
              label: m.merchant,
              category: '',
              suggest: '',
              excluded: '',
              field: 'description',
            });
            merchantMap.delete(m.merchant);
          } else if (picked === 'inc') {
            cpMap.set(m.merchant, {
              match: m.merchant,
              kind: 'income',
              label: m.merchant,
              category: '',
              suggest: '',
              excluded: '',
              field: 'description',
            });
            merchantMap.delete(m.merchant);
          }
        }
      }

      const merchantRowsToWrite: Row[] = [...merchantMap.entries()]
        .filter(([match, cat]) => match && cat)
        .map(([match, cat]) => [match, cat]);
      const cpRowsToWrite: Row[] = [...cpMap.values()]
        .filter((r) => r.match && r.kind && r.label)
        .map((r) => [r.match, r.kind, r.label, r.category, r.suggest, r.excluded, r.field]);

      await rewriteTab(api, 'merchant_rules', MERCHANT_HEADERS, merchantRowsToWrite);
      await rewriteTab(api, 'counterparty_rules', CP_HEADERS, cpRowsToWrite);

      setStatus(
        touched > 0
          ? `Saved overrides (${touched} new / changed). Merchant: ${merchantRowsToWrite.length}, counterparty: ${cpRowsToWrite.length}.`
          : `No changes.`,
      );
    });
  }

  async function applyToOperations(): Promise<void> {
    await withBusy(async () => {
      const config = await loadClassifyConfig(api);
      const result = await reclassifyAll(api, config);
      setStatus(`Re-classified. Updated: ${result.updated}, unchanged: ${result.unchanged}.`);
    });
  }

  async function withBusy(fn: () => Promise<void>): Promise<void> {
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

  function addBalance(): void {
    setBalances([...balances, { name: '', currency: '', type: '', archived: false }]);
  }

  function updateMerchant(bankCategory: string, merchant: string, picked: string): void {
    setBankCats(
      bankCats.map((b) => {
        if (b.bankCategory !== bankCategory) return b;
        return {
          ...b,
          merchants: b.merchants.map((m) =>
            m.merchant === merchant ? { ...m, picked } : m,
          ),
        };
      }),
    );
  }

  const balanceNames = balances
    .filter((b) => b.name.trim() && !b.archived)
    .map((b) => b.name.trim());

  // Card routing can legitimately point at a closed account (a retired card →
  // an archived balance), so its picker offers archived balances too —
  // labelled, and listed after the active ones. balanceNames (active only)
  // still drives the "transfer to balance" picker for new operations.
  const routingBalances = balances
    .filter((b) => b.name.trim())
    .map((b) => ({ name: b.name.trim(), archived: b.archived }))
    .sort((a, b) => Number(a.archived) - Number(b.archived));

  if (loading) {
    return (
      <>
        <h1>Rules</h1>
        <p className="muted">Reading the spreadsheet…</p>
      </>
    );
  }

  return (
    <>
      <h1>Rules</h1>
      <p className="muted">
        Manage balances, route bank cards into them, map bank categories,
        and override per merchant when a bank category is too coarse.
        "Apply" re-classifies existing operations so changes show up immediately.
      </p>

      <details className="section">
        <summary>Balances</summary>
        <p className="hint">
          Your canonical accounts (flat list). A balance can be fed by a bank
          card, by transfers, or by manual entry.
        </p>
      <table className="rules">
        <thead>
          <tr>
            <th>name</th>
            <th>cur</th>
            <th>type</th>
            <th>arch</th>
          </tr>
        </thead>
        <tbody>
          {balances.map((b, i) => (
            <tr key={i}>
              <td>
                <input
                  type="text"
                  value={b.name}
                  placeholder="e.g. Main RUB"
                  onChange={(e) => updateAt(balances, setBalances, i, { name: e.target.value })}
                />
              </td>
              <td>
                <input
                  type="text"
                  value={b.currency}
                  placeholder="RUB"
                  style={{ width: 60 }}
                  onChange={(e) => updateAt(balances, setBalances, i, { currency: e.target.value })}
                />
              </td>
              <td>
                <input
                  type="text"
                  value={b.type}
                  placeholder="card"
                  style={{ width: 72 }}
                  onChange={(e) => updateAt(balances, setBalances, i, { type: e.target.value })}
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={b.archived}
                  style={{ width: 'auto' }}
                  onChange={(e) =>
                    updateAt(balances, setBalances, i, { archived: e.target.checked })
                  }
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
        <div className="row" style={{ gap: 8 }}>
          <button className="secondary" onClick={addBalance} disabled={busy}>
            + Add balance
          </button>
          <button className="secondary" onClick={saveBalances} disabled={busy}>
            Save balances
          </button>
        </div>
      </details>

      <details className="section">
        <summary>Card routing</summary>
      {accounts.length === 0 ? (
        <p className="hint">No operations imported yet — import a statement first.</p>
      ) : (
        <>
          <p className="hint">
            Each distinct (source, card) seen in <code>operations</code>. Route it
            into a balance. Empty tail = the channel default (interest, cashback).
          </p>
          <table className="rules">
            <thead>
              <tr>
                <th>source</th>
                <th>card</th>
                <th>ops</th>
                <th>balance</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a, i) => (
                <tr key={`${a.sourceChannel}|${a.tail}`}>
                  <td>{a.sourceChannel}</td>
                  <td>
                    <code>{a.tail || '—'}</code>
                  </td>
                  <td>{a.count}</td>
                  <td>
                    <select
                      value={a.balance}
                      onChange={(e) =>
                        updateAt(accounts, setAccounts, i, { balance: e.target.value })
                      }
                    >
                      <option value="">— unrouted —</option>
                      {routingBalances.map((b) => (
                        <option key={b.name} value={b.name}>
                          {b.archived ? `${b.name} (archived)` : b.name}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="secondary" onClick={saveAccounts} disabled={busy}>
            Save routing
          </button>
        </>
      )}
      </details>

      <details className="section" open>
        <summary>Bank categories</summary>
      {bankCats.length === 0 ? (
        <p className="hint">No bank-provided categories found in operations.</p>
      ) : (
        <>
          <p className="hint">
            Pick a default user category per bank bucket. Tap a row to drill into
            merchants and override individual ones (creates <code>merchant_rules</code>).
          </p>
          <div className="bank-cats">
            {bankCats.map((b, i) => (
              <details key={b.bankCategory} className="bank-cat">
                <summary>
                  <span className="bc-name">{b.bankCategory}</span>
                  <span className="bc-count">{b.count}</span>
                  <select
                    value={b.category}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => updateAt(bankCats, setBankCats, i, { category: e.target.value })}
                  >
                    <option value="">— unmapped —</option>
                    {categories.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </summary>
                <div className="merchants">
                  {b.merchants.length === 0 ? (
                    <div className="hint">No distinct merchants.</div>
                  ) : (
                    <table className="rules">
                      <thead>
                        <tr>
                          <th>merchant</th>
                          <th>ops</th>
                          <th>override category</th>
                        </tr>
                      </thead>
                      <tbody>
                        {b.merchants.map((m) => (
                          <tr key={m.merchant}>
                            <td>
                              <code>{m.merchant}</code>
                              {m.existingMatch && (
                                <div className="hint">
                                  rule: <code>{m.existingMatch}</code> → {describePicked(m.existingPicked)}
                                </div>
                              )}
                            </td>
                            <td>{m.count}</td>
                            <td>
                              <select
                                value={m.picked}
                                onChange={(e) =>
                                  updateMerchant(b.bankCategory, m.merchant, e.target.value)
                                }
                              >
                                <option value="">— use default —</option>
                                <optgroup label="Expense category">
                                  {categories.map((c) => (
                                    <option key={`exp:${c}`} value={`exp:${c}`}>
                                      {c}
                                    </option>
                                  ))}
                                </optgroup>
                                <optgroup label="Transfer to balance">
                                  {balanceNames.map((n) => (
                                    <option key={`trf:${n}`} value={`trf:${n}`}>
                                      {n}
                                    </option>
                                  ))}
                                </optgroup>
                                <optgroup label="Other">
                                  <option value="peer">Peer transfer</option>
                                  <option value="inc">Income</option>
                                </optgroup>
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </details>
            ))}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="secondary" onClick={saveBankCategories} disabled={busy}>
              Save bank categories
            </button>
            <button className="secondary" onClick={saveOverrides} disabled={busy}>
              Save merchant overrides
            </button>
          </div>
        </>
      )}
      </details>

      <details className="section" open>
        <summary>Apply to existing operations</summary>
        <p className="hint">
          Recomputes <code>kind</code>, <code>category</code>, <code>counterparty</code>,
          <code>accountName</code> for every row using the current rules. Fields pinned
          via <code>manualOverride</code> are kept.
        </p>
        <button className="primary" onClick={applyToOperations} disabled={busy}>
          {busy ? 'Working…' : 'Apply now'}
        </button>
      </details>

      {status && <div className="ok">{status}</div>}
      {error && <div className="error">{error}</div>}
    </>
  );
}

function describePicked(picked: string): string {
  if (!picked) return 'default';
  if (picked.startsWith('exp:')) return `expense → ${picked.slice(4)}`;
  if (picked.startsWith('trf:')) return `transfer → ${picked.slice(4)}`;
  if (picked === 'peer') return 'peer transfer';
  if (picked === 'inc') return 'income';
  return picked;
}

function updateAt<T>(list: T[], setList: (next: T[]) => void, i: number, patch: Partial<T>): void {
  const next = [...list];
  next[i] = { ...next[i]!, ...patch };
  setList(next);
}

async function safeRead(api: SheetsAPI, range: string): Promise<string[][]> {
  try {
    return await api.getValues(range);
  } catch {
    return [];
  }
}

async function rewriteTab(
  api: SheetsAPI,
  tab: string,
  headers: string[],
  rows: Row[],
): Promise<void> {
  const tabs = await api.listTabs();
  if (!tabs.includes(tab)) {
    await api.ensureTab(tab);
  } else {
    // Don't clear a same-named tab that the user built for something else.
    await assertWritableTab(api, tab, headers);
  }
  await api.clearRange(`${tab}!A:Z`);
  await api.updateValues(`${tab}!A1`, [headers as unknown as Row, ...rows]);
}
