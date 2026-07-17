import { useState } from 'react';
import {
  applyCategoryMigration,
  previewCategoryMigration,
  type CategoryRename,
  type MigrationReport,
  type SheetsAPI,
} from '@mtrack/core';

/**
 * Category rename / merge tool (Rules → "Category maintenance").
 *
 * The user queues rename pairs (`from` picked from existing categories,
 * `to` typed freely — an existing name turns the rename into a merge),
 * previews how many cells each pair touches across the five places a
 * category name lives in, then applies. Apply re-reads the sheet itself,
 * so a stale preview can't misdirect it; the preview is a required step
 * only to make the blast radius visible before an invasive write.
 */

interface Props {
  api: SheetsAPI;
  categories: string[];
  busy: boolean;
  onBusy: (fn: () => Promise<void>) => Promise<void>;
  /** Called after a successful apply so the parent can reload sheet data. */
  onMigrated: () => void;
}

interface PairDraft {
  from: string;
  to: string;
}

export function CategoryMaintenance({
  api,
  categories,
  busy,
  onBusy,
  onMigrated,
}: Props): React.JSX.Element {
  const [pairs, setPairs] = useState<PairDraft[]>([{ from: '', to: '' }]);
  const [report, setReport] = useState<MigrationReport | null>(null);
  const [applied, setApplied] = useState(false);

  const validPairs: CategoryRename[] = pairs
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
      setReport(await previewCategoryMigration(api, validPairs));
    });
  }

  async function apply(): Promise<void> {
    const total = report?.renames.reduce((s, r) => s + r.operationRows, 0) ?? 0;
    if (
      !confirm(
        `Rewrite category names in config tabs and ${total} operation rows? ` +
          'Make a backup copy of the spreadsheet first (File → Make a copy) if you have not.',
      )
    ) {
      return;
    }
    await onBusy(async () => {
      const result = await applyCategoryMigration(api, validPairs);
      setReport(result);
      setApplied(true);
      setPairs([{ from: '', to: '' }]);
      onMigrated();
    });
  }

  return (
    <>
      <p className="hint">
        Rename or merge categories everywhere at once: the <code>categories</code> tab
        (names and parents), all three rule tabs, and every affected <code>operations</code> row —
        including rows pinned via <code>manualOverride</code>. Typing an existing name as the
        target merges into it. Dashboard formulas referencing old names are NOT migrated —
        check them yourself afterwards.
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
                <select value={p.from} onChange={(e) => editPair(i, { from: e.target.value })}>
                  <option value="">— pick —</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  type="text"
                  value={p.to}
                  placeholder="new or existing name"
                  list="category-names"
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
      <datalist id="category-names">
        {categories.map((c) => (
          <option key={c} value={c} />
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
                <th>cats</th>
                <th>rules</th>
                <th>ops</th>
              </tr>
            </thead>
            <tbody>
              {report.renames.map((r) => (
                <tr key={r.from}>
                  <td>
                    {r.from} → {r.to}
                    {r.merge && <span className="hint"> (merge)</span>}
                  </td>
                  <td>{r.categoryRows + r.parentRefs}</td>
                  <td>{r.bankMapRefs + r.merchantRuleRefs + r.counterpartyRuleRefs}</td>
                  <td>{r.operationRows}</td>
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
