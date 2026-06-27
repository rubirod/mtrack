import { useEffect, useMemo, useState } from 'react';
import {
  appendMerchantRule,
  applyOperationPatch,
  loadClassifyConfig,
  OPERATION_HEADERS,
  type Row,
  type SheetsAPI,
  type ValueRange,
} from '@mtrack/core';
import type { Settings } from './settings';
import { createSheetsAPI } from './google';
import { clusterMerchant } from './merchants';
import { suggestCategories } from './ai';

/**
 * Confirm tab — Layer 2 review queue.
 *
 * Surfaces operations that still need a human: uncategorised expenses and rows
 * a rule flagged with needsConfirmation. Identical merchants are grouped (via
 * `clusterMerchant`) so one decision closes many ops, mirroring the manual
 * triage flow. A merchant that spans several bank categories is shown split
 * into linked sub-cards, one per bank category, so the user sees and confirms
 * each bucket separately (e.g. a park's food kiosk vs its entry ticket).
 *
 * Per group: accept the (pre-filled) category — pins it via manualOverride;
 * ask the AI for a suggestion; or turn it into a merchant rule (optionally
 * scoped to the bank category) that also classifies the group now. Writes go
 * straight to the rows already in memory via one batchUpdate — no full re-read.
 */

interface Props {
  settings: Settings;
}

const COL = Object.fromEntries(OPERATION_HEADERS.map((h, i) => [h, i])) as Record<
  (typeof OPERATION_HEADERS)[number],
  number
>;
const LAST_COL = String.fromCharCode('A'.charCodeAt(0) + OPERATION_HEADERS.length - 1);

interface QItem {
  rowNum: number;
  row: string[];
}

interface Group {
  key: string;
  merchant: string; // cluster key / rule match; '' when the row has no description
  bankCategory: string; // '' when not scoped
  scoped: boolean; // write bankCategory into the rule's column C
  items: QItem[];
  picked: string;
  ai: boolean;
  done: string | null;
}

type Block =
  | { kind: 'single'; group: Group }
  | { kind: 'split'; merchant: string; groups: Group[] };

type Filter = 'uncategorized' | 'needsConfirm' | 'all';

function isTrue(v: string | undefined): boolean {
  return String(v ?? '').trim().toUpperCase() === 'TRUE';
}

function overrideHas(cell: string | undefined, field: string): boolean {
  return String(cell ?? '')
    .split(',')
    .map((s) => s.trim())
    .includes(field);
}

export function ConfirmScreen({ settings }: Props): React.JSX.Element {
  const api = useMemo<SheetsAPI>(
    () => createSheetsAPI(settings.spreadsheetId),
    [settings.spreadsheetId],
  );

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('uncategorized');
  const [categories, setCategories] = useState<string[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [catRows, opRows, config] = await Promise.all([
          api.getValues('categories!A2:A'),
          api.getValues(`operations!A2:${LAST_COL}`),
          loadClassifyConfig(api),
        ]);
        if (cancelled) return;
        const cats = catRows.map((r) => r[0]).filter((c): c is string => Boolean(c));
        setCategories(cats);
        setBlocks(buildBlocks(opRows, filter, config.bankCategoryMap));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Rebuilds when the filter changes; opRows are re-read (cheap relative to the
    // triage the user is about to do, and keeps the queue fresh after writes).
  }, [api, filter]);

  function updateGroup(key: string, patch: Partial<Group>): void {
    setBlocks((prev) =>
      prev.map((b) => {
        if (b.kind === 'single') {
          return b.group.key === key ? { kind: 'single', group: { ...b.group, ...patch } } : b;
        }
        return {
          ...b,
          groups: b.groups.map((g) => (g.key === key ? { ...g, ...patch } : g)),
        };
      }),
    );
  }

  async function writeRows(updates: Array<{ rowNum: number; row: Row }>): Promise<void> {
    const data: ValueRange[] = updates.map(({ rowNum, row }) => ({
      range: `operations!A${rowNum}:${LAST_COL}${rowNum}`,
      values: [row],
    }));
    await api.batchUpdateValues(data);
  }

  async function acceptGroup(g: Group): Promise<void> {
    if (!g.picked) {
      setError('Pick a category first.');
      return;
    }
    await run(async () => {
      const updates = g.items.map(({ rowNum, row }) => ({
        rowNum,
        row: applyOperationPatch(
          row,
          { category: g.picked, needsConfirmation: false, source: 'manual' },
          ['category'],
        ),
      }));
      await writeRows(updates);
      updateGroup(g.key, { done: g.picked });
      setStatus(`Pinned ${g.items.length} → ${g.picked}.`);
    });
  }

  async function makeRule(g: Group): Promise<void> {
    if (!g.picked) {
      setError('Pick a category first.');
      return;
    }
    if (!g.merchant) {
      setError('No merchant text to build a rule from — use Accept instead.');
      return;
    }
    await run(async () => {
      await appendMerchantRule(api, {
        match: g.merchant,
        category: g.picked,
        bankCategory: g.scoped ? g.bankCategory : undefined,
      });
      const updates = g.items.map(({ rowNum, row }) => ({
        rowNum,
        row: applyOperationPatch(row, {
          category: g.picked,
          needsConfirmation: false,
          source: 'rule',
        }),
      }));
      await writeRows(updates);
      updateGroup(g.key, { done: g.picked });
      const scope = g.scoped ? ` [bank: ${g.bankCategory}]` : '';
      setStatus(`Rule added: "${g.merchant}" → ${g.picked}${scope}, applied to ${g.items.length}.`);
    });
  }

  async function askAI(groups: Group[]): Promise<void> {
    if (!settings.anthropicKey) {
      setError('Add an Anthropic key in More to use AI suggestions.');
      return;
    }
    const targets = groups.filter((g) => !g.done && g.merchant);
    if (targets.length === 0) return;
    await run(async () => {
      const suggestions = await suggestCategories(
        settings.anthropicKey,
        targets.map((g) => ({ merchant: g.merchant, bankCategory: g.bankCategory || undefined })),
        categories,
      );
      let n = 0;
      for (const g of targets) {
        const s = suggestions[g.merchant];
        if (s) {
          updateGroup(g.key, { picked: s, ai: true });
          n++;
        }
      }
      setStatus(`AI suggested ${n} of ${targets.length}.`);
    });
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

  const allGroups = blocks.flatMap((b) => (b.kind === 'single' ? [b.group] : b.groups));
  const remaining = allGroups.filter((g) => !g.done);
  const remOps = remaining.reduce((n, g) => n + g.items.length, 0);

  return (
    <>
      <h1>Confirm</h1>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <p className="muted" style={{ margin: 0 }}>
          {loading
            ? 'Reading the spreadsheet…'
            : `${remaining.length} merchants · ${remOps} operations to review`}
        </p>
        <select value={filter} disabled={busy} onChange={(e) => setFilter(e.target.value as Filter)}>
          <option value="uncategorized">uncategorized</option>
          <option value="needsConfirm">needs a tap</option>
          <option value="all">all</option>
        </select>
      </div>

      {!loading && remaining.length > 0 && (
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void askAI(remaining.filter((g) => !g.picked))}
          style={{ margin: '8px 0' }}
        >
          ✨ Ask AI for the ones without a default
        </button>
      )}

      {blocks.map((b) =>
        b.kind === 'single' ? (
          <GroupCard
            key={b.group.key}
            g={b.group}
            categories={categories}
            busy={busy}
            onPick={(c) => updateGroup(b.group.key, { picked: c, ai: false })}
            onAccept={() => void acceptGroup(b.group)}
            onAI={() => void askAI([b.group])}
            onRule={() => void makeRule(b.group)}
          />
        ) : (
          <SplitCard
            key={'split:' + b.merchant}
            block={b}
            categories={categories}
            busy={busy}
            onPick={(key, c) => updateGroup(key, { picked: c, ai: false })}
            onAccept={(g) => void acceptGroup(g)}
            onAI={(g) => void askAI([g])}
            onRule={(g) => void makeRule(g)}
          />
        ),
      )}

      {!loading && remaining.length === 0 && (
        <p className="muted">Nothing to review for this filter. 🎉</p>
      )}

      {status && <div className="ok">{status}</div>}
      {error && <div className="error">{error}</div>}
    </>
  );
}

function GroupCard(props: {
  g: Group;
  categories: string[];
  busy: boolean;
  onPick: (c: string) => void;
  onAccept: () => void;
  onAI: () => void;
  onRule: () => void;
  nested?: boolean;
}): React.JSX.Element {
  const { g, categories, busy, onPick, onAccept, onAI, onRule, nested } = props;

  if (g.done) {
    return (
      <div className={nested ? 'sub done' : 'card done'}>
        ✓ {g.merchant || '(no description)'} → {g.done} · {g.items.length} ops
      </div>
    );
  }

  return (
    <div className={nested ? 'sub' : 'card'}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong>{g.merchant || '(no description)'}</strong>
        <span className="muted">×{g.items.length}</span>
      </div>
      <div className="hint">
        {g.scoped ? `bank: ${g.bankCategory}` : g.bankCategory ? `bank: ${g.bankCategory}` : 'no bank category'}
      </div>
      <select value={g.picked} disabled={busy} onChange={(e) => onPick(e.target.value)}>
        <option value="">— pick a category —</option>
        {categories.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      {g.ai && <span className="hint">✨ suggested by AI</span>}
      <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <button className="primary" disabled={busy} onClick={onAccept}>
          ✓ Accept
        </button>
        <button className="secondary" disabled={busy} onClick={onAI}>
          ✨ Ask AI
        </button>
        <button className="secondary" disabled={busy || !g.merchant} onClick={onRule}>
          ⛭ Make rule{g.scoped ? ` → C: ${g.bankCategory}` : ''}
        </button>
      </div>
    </div>
  );
}

function SplitCard(props: {
  block: Extract<Block, { kind: 'split' }>;
  categories: string[];
  busy: boolean;
  onPick: (key: string, c: string) => void;
  onAccept: (g: Group) => void;
  onAI: (g: Group) => void;
  onRule: (g: Group) => void;
}): React.JSX.Element {
  const { block, categories, busy, onPick, onAccept, onAI, onRule } = props;
  const total = block.groups.reduce((n, g) => n + g.items.length, 0);
  return (
    <div className="card split">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong>{block.merchant}</strong>
        <span className="badge">splits by bank category · ×{total}</span>
      </div>
      {block.groups.map((g) => (
        <GroupCard
          key={g.key}
          g={g}
          categories={categories}
          busy={busy}
          nested
          onPick={(c) => onPick(g.key, c)}
          onAccept={() => onAccept(g)}
          onAI={() => onAI(g)}
          onRule={() => onRule(g)}
        />
      ))}
    </div>
  );
}

/** Turns raw operation rows into review blocks, grouped by merchant and split
 *  by bank category when a merchant spans more than one. */
function buildBlocks(
  rows: string[][],
  filter: Filter,
  bankMap: ReadonlyMap<string, string>,
): Block[] {
  const items: Array<QItem & { merchant: string; bankCategory: string }> = [];

  rows.forEach((row, idx) => {
    const id = row[COL.id];
    if (!id) return;
    const category = String(row[COL.category] ?? '');
    const kind = String(row[COL.kind] ?? '');
    const needsConfirm = isTrue(row[COL.needsConfirmation]);
    if (overrideHas(row[COL.manualOverride], 'category')) return;

    const uncategorised = category === '' && kind === 'expense';
    const inQueue =
      filter === 'needsConfirm'
        ? needsConfirm
        : filter === 'uncategorized'
          ? uncategorised
          : uncategorised || needsConfirm;
    if (!inQueue) return;

    items.push({
      rowNum: idx + 2,
      row,
      merchant: clusterMerchant(String(row[COL.description] ?? '')),
      bankCategory: String(row[COL.bankCategory] ?? ''),
    });
  });

  // Cluster by merchant key.
  const byMerchant = new Map<string, typeof items>();
  for (const it of items) {
    const list = byMerchant.get(it.merchant) ?? [];
    list.push(it);
    byMerchant.set(it.merchant, list);
  }

  const blocks: Block[] = [];
  for (const [merchant, list] of byMerchant) {
    const bankCats = [...new Set(list.map((i) => i.bankCategory).filter(Boolean))];
    const def = (bc: string): string => bankMap.get(bc) ?? '';

    if (merchant && bankCats.length > 1) {
      const groups: Group[] = bankCats.map((bc) => {
        const sub = list.filter((i) => i.bankCategory === bc);
        return mkGroup(`${merchant}|${bc}`, merchant, bc, true, sub, def(bc));
      });
      const noBank = list.filter((i) => !i.bankCategory);
      if (noBank.length) {
        groups.push(mkGroup(`${merchant}|`, merchant, '', false, noBank, ''));
      }
      blocks.push({ kind: 'split', merchant, groups });
    } else {
      const bc = bankCats[0] ?? '';
      blocks.push({
        kind: 'single',
        group: mkGroup(merchant || '(none)', merchant, bc, false, list, def(bc)),
      });
    }
  }

  // Most-impactful merchants first.
  blocks.sort((a, b) => blockOps(b) - blockOps(a));
  return blocks;
}

function blockOps(b: Block): number {
  return b.kind === 'single'
    ? b.group.items.length
    : b.groups.reduce((n, g) => n + g.items.length, 0);
}

function mkGroup(
  key: string,
  merchant: string,
  bankCategory: string,
  scoped: boolean,
  items: QItem[],
  picked: string,
): Group {
  return { key, merchant, bankCategory, scoped, items, picked, ai: false, done: null };
}
