import { useState } from 'react';
import {
  applyBalanceMigration,
  previewBalanceMigration,
  type BalanceMigrationReport,
  type BalanceRename,
  type SheetsAPI,
} from '@mtrack/core';

/**
 * Balance rename / merge tool (Rules → "Balance maintenance").
 *
 * Same shape as the category tool: queue pairs, preview the blast radius,
 * apply. Merging is what this exists for — two balances that mean the same
 * thing (one from a backup import, one from later statement imports) can't be
 * unified by editing the `balances` tab, because operations keep pointing at
 * both names through `accountName` and `counterparty`.
 */

interface Props {
  api: SheetsAPI;
  /** All balance names, archived included — a dead balance is exactly what one merges away. */
  balances: string[];
  busy: boolean;
  onBusy: (fn: () => Promise<void>) => Promise<void>;
  /** Called after a successful apply so the parent can reload sheet data. */
  onMigrated: () => void;
}

interface PairDraft {
  from: string;
  to: string;
}

export function BalanceMaintenance({
  api,
  balances,
  busy,
  onBusy,
  onMigrated,
}: Props): React.JSX.Element {
  const [pairs, setPairs] = useState<PairDraft[]>([{ from: '', to: '' }]);
  const [report, setReport] = useState<BalanceMigrationReport | null>(null);
  const [applied, setApplied] = useState(false);

  const validPairs: BalanceRename[] = pairs
    .filter((p) => p.from.trim() && p.to.trim() && p.from.trim() !== p.to.trim())
    .map((p) => ({ from: p.from.trim(), to: p.to.trim() }));

  function editPair(i: number, patch: Partial<PairDraft>): void {
    const next = [...pairs];
    next[i] = { ...next[i]!, ...patch };
    setPairs(next);
    setReport(null); // stale counts must not survive an edit
    setApplied(false);
  }

  function removePair(i: number): void {
    const next = pairs.filter((_, idx) => idx !== i);
    setPairs(next.length ? next : [{ from: '', to: '' }]);
    setReport(null);
    setApplied(false);
  }

  async function preview(): Promise<void> {
    await onBusy(async () => {
      setApplied(false);
      setReport(await previewBalanceMigration(api, validPairs));
    });
  }

  async function apply(): Promise<void> {
    const total =
      report?.renames.reduce((s, r) => s + r.accountNameRows + r.counterpartyRows, 0) ?? 0;
    if (
      !confirm(
        `Rewrite balance names in the config tabs and ${total} operation cells? ` +
          'Make a backup copy of the spreadsheet first (File → Make a copy) if you have not.',
      )
    ) {
      return;
    }
    await onBusy(async () => {
      const result = await applyBalanceMigration(api, validPairs);
      setReport(result);
      setApplied(true);
      setPairs([{ from: '', to: '' }]);
      onMigrated();
    });
  }

  return (
    <>
      <p className="hint">
        Rename or merge balances everywhere at once: the <code>balances</code> tab, the{' '}
        <code>accounts</code> routing, the <code>label</code> column of{' '}
        <code>counterparty_rules</code>, and both <code>accountName</code> and{' '}
        <code>counterparty</code> in every affected <code>operations</code> row — including rows
        pinned via <code>manualOverride</code>. Picking an existing name as the target merges into
        it: the source row is cleared and its cards are re-routed into the survivor. Dashboard
        formulas referencing old names are NOT migrated — check them yourself afterwards.
      </p>

      <table className="rules">
        <thead>
          <tr>
            <th>from</th>
            <th>to</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {pairs.map((p, i) => (
            <tr key={i}>
              <td>
                {/* Free text, not a picker: a name that survives only in
                    `operations` (its `balances` row already deleted) is
                    exactly the kind of leftover this tool cleans up. */}
                <input
                  type="text"
                  value={p.from}
                  placeholder="old name"
                  list="balance-names"
                  onChange={(e) => editPair(i, { from: e.target.value })}
                />
              </td>
              <td>
                <input
                  type="text"
                  value={p.to}
                  placeholder="new or existing name"
                  list="balance-names"
                  onChange={(e) => editPair(i, { to: e.target.value })}
                />
              </td>
              <td>
                <button
                  className="secondary"
                  onClick={() => removePair(i)}
                  disabled={busy}
                  aria-label="Remove rename"
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <datalist id="balance-names">
        {balances.map((b) => (
          <option key={b} value={b} />
        ))}
      </datalist>

      <div className="row" style={{ gap: 8 }}>
        <button
          className="secondary"
          onClick={() => setPairs([...pairs, { from: '', to: '' }])}
          disabled={busy}
        >
          + Add rename
        </button>
        <button className="secondary" onClick={preview} disabled={busy || validPairs.length === 0}>
          Preview
        </button>
      </div>

      {report && (
        <>
          <table className="rules" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>rename</th>
                <th>routing</th>
                <th>rules</th>
                <th>ops acct</th>
                <th>ops cpty</th>
              </tr>
            </thead>
            <tbody>
              {report.renames.map((r) => (
                <tr key={r.from}>
                  <td>
                    {r.from} → {r.to}
                    {r.merge && <span className="hint"> (merge)</span>}
                  </td>
                  <td>{r.routingRefs}</td>
                  <td>{r.ruleLabelRefs}</td>
                  <td>{r.accountNameRows}</td>
                  <td>{r.counterpartyRows}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">
            {report.cellWrites} cell writes total.
            {applied
              ? ' Done. Run "Apply now" below — it should report ~0 updates caused by these renames.'
              : ''}
          </p>
          {!applied && (
            <button className="primary" onClick={apply} disabled={busy || validPairs.length === 0}>
              {busy ? 'Working…' : 'Apply migration'}
            </button>
          )}
        </>
      )}
    </>
  );
}
