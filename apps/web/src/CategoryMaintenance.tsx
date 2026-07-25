import { useState } from 'react';
import {
  applyCategoryMigration,
  applyCategoryReassign,
  previewCategoryMigration,
  previewCategoryReassign,
  type CategoryRename,
  type CategoryReassign,
  type MigrationReport,
  type ReassignReport,
  type SheetsAPI,
} from '@mtrack/core';
import { CategoryOptions, type CategoryTree } from './category-tree';

/**
 * Category maintenance (Rules → "Category maintenance"). Two tools, because
 * there are two distinct verbs and confusing them corrupts the tree:
 *
 *  - **Rename / merge** — the name ceases to exist and is replaced everywhere,
 *    `parent` cells included, so children follow their renamed parent instead
 *    of being orphaned.
 *  - **Move operations** — the category keeps existing (usually because it
 *    groups others) but stops holding operations of its own. Only operations
 *    and the rules that produced them are repointed; the tree is untouched.
 *
 * Both preview first: the count of affected cells is the only warning before
 * an invasive write, and Apply re-reads the sheet so a stale preview can't
 * misdirect it.
 */

interface Props {
  api: SheetsAPI;
  /** Every category name, groups included — renaming a group is legitimate. */
  categories: string[];
  /** Tree, so the move tool can offer only leaves as a destination. */
  tree: CategoryTree;
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
  tree,
  busy,
  onBusy,
  onMigrated,
}: Props): React.JSX.Element {
  const [pairs, setPairs] = useState<PairDraft[]>([{ from: '', to: '' }]);
  const [report, setReport] = useState<MigrationReport | null>(null);
  const [applied, setApplied] = useState(false);
  const [move, setMove] = useState<PairDraft>({ from: '', to: '' });
  const [moveReport, setMoveReport] = useState<ReassignReport | null>(null);
  const [moveApplied, setMoveApplied] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);

  const moveValid = Boolean(move.from.trim() && move.to.trim() && move.from !== move.to);
  const moves: CategoryReassign[] = moveValid
    ? [{ from: move.from.trim(), to: move.to.trim() }]
    : [];

  function editMove(patch: Partial<PairDraft>): void {
    setMove({ ...move, ...patch });
    setMoveReport(null);
    setMoveApplied(false);
    setMoveError(null);
  }

  async function previewMove(): Promise<void> {
    await onBusy(async () => {
      setMoveApplied(false);
      setMoveError(null);
      try {
        setMoveReport(await previewCategoryReassign(api, moves));
      } catch (e) {
        setMoveReport(null);
        setMoveError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  async function applyMove(): Promise<void> {
    const n = moveReport?.moves[0]?.operationRows ?? 0;
    if (!confirm(`Move ${n} operations from "${move.from}" to "${move.to}"?`)) return;
    await onBusy(async () => {
      try {
        setMoveReport(await applyCategoryReassign(api, moves));
        setMoveApplied(true);
        setMove({ from: '', to: '' });
        onMigrated();
      } catch (e) {
        setMoveError(e instanceof Error ? e.message : String(e));
      }
    });
  }

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
      <h3 style={{ marginTop: 0 }}>Move operations to another category</h3>
      <p className="hint">
        Empties a category of its operations while keeping it in the tree — what a
        grouping node needs when it accidentally holds operations of its own
        (an operation should always sit on a leaf). Only <code>operations</code> and the
        rules that produced them are repointed; the <code>categories</code> tab is not
        touched. The destination list offers leaves only.
      </p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <select
          value={move.from}
          disabled={busy}
          aria-label="Move operations from"
          onChange={(e) => editMove({ from: e.target.value })}
        >
          <option value="">— from —</option>
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select
          value={move.to}
          disabled={busy}
          aria-label="Move operations to"
          onChange={(e) => editMove({ to: e.target.value })}
        >
          <option value="">— to (leaf) —</option>
          <CategoryOptions tree={tree} />
        </select>
        <button className="secondary" onClick={previewMove} disabled={busy || !moveValid}>
          Preview
        </button>
      </div>
      {moveError && <div className="error">{moveError}</div>}
      {moveReport && moveReport.moves[0] && (
        <p className="hint">
          {moveReport.moves[0].operationRows} operations,{' '}
          {moveReport.moves[0].bankMapRefs +
            moveReport.moves[0].merchantRuleRefs +
            moveReport.moves[0].counterpartyRuleRefs}{' '}
          rules — {moveReport.cellWrites} cell writes.
          {moveApplied ? ' Done.' : ''}
        </p>
      )}
      {moveReport && !moveApplied && (
        <button className="primary" onClick={applyMove} disabled={busy || !moveValid}>
          {busy ? 'Working…' : 'Move operations'}
        </button>
      )}

      <h3>Rename or merge a category</h3>
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
