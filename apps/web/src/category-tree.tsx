/**
 * The `categories` tab as a tree, for the pickers.
 *
 * Storage is an adjacency list: `name | parent`, where a parent is an ordinary
 * row of the same tab (the shape Money Pro uses, kept so the backup import is
 * lossless). Nothing marks a row as "a group" — a name is a group precisely
 * because some other row names it as its parent.
 *
 * Screens used to read column A alone, which erased that distinction: grouping
 * nodes were offered for selection exactly like leaves, so «Подарки и цветы»
 * sat in the list next to its own children «Подарки» and «Цветы». Since an
 * operation must always store a leaf (the parent is for grouping in reports),
 * a chosen group is simply wrong data. Reading both columns turns groups into
 * `<optgroup>` labels, which HTML makes unselectable — the rule is enforced by
 * the widget instead of by the user remembering it.
 */

import type { SheetsAPI } from '@mtrack/core';

export interface CategoryTree {
  /** Grouping nodes with their leaves, in sheet order. */
  groups: Array<{ parent: string; children: string[] }>;
  /** Leaves that belong to no group. */
  loose: string[];
  /** Every selectable leaf, flat — for callers that just need a lookup. */
  leaves: string[];
}

export const EMPTY_TREE: CategoryTree = { groups: [], loose: [], leaves: [] };

/** Builds the tree from raw `name | parent` rows. */
export function buildCategoryTree(rows: readonly (readonly string[])[]): CategoryTree {
  const entries = rows
    .map((r) => ({ name: String(r[0] ?? '').trim(), parent: String(r[1] ?? '').trim() }))
    .filter((e) => e.name);

  const childrenOf = new Map<string, string[]>();
  for (const e of entries) {
    if (!e.parent) continue;
    const arr = childrenOf.get(e.parent);
    if (arr) arr.push(e.name);
    else childrenOf.set(e.parent, [e.name]);
  }

  const groups: CategoryTree['groups'] = [];
  const loose: string[] = [];
  for (const e of entries) {
    const children = childrenOf.get(e.name);
    if (children) {
      // A node with children is a group, even if it also has a parent of its
      // own — `<optgroup>` cannot nest, so one level is all a picker can show.
      groups.push({ parent: e.name, children });
      continue;
    }
    if (!e.parent) loose.push(e.name);
    // A leaf with a parent is listed under that parent's group, not here.
  }

  const leaves = [...groups.flatMap((g) => g.children), ...loose];
  return { groups, loose, leaves };
}

/** Reads the `categories` tab. A missing or unreadable tab yields an empty tree. */
export async function loadCategoryTree(api: SheetsAPI): Promise<CategoryTree> {
  try {
    return buildCategoryTree(await api.getValues('categories!A2:B'));
  } catch {
    return EMPTY_TREE;
  }
}

/**
 * `<option>` list for a category `<select>`: groups become `<optgroup>`
 * labels, so only leaves can be picked. Render inside a `<select>`, after
 * whatever placeholder option the caller wants.
 */
export function CategoryOptions({ tree }: { tree: CategoryTree }): React.JSX.Element {
  return (
    <>
      {tree.groups.map((g) => (
        <optgroup key={g.parent} label={g.parent}>
          {g.children.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </optgroup>
      ))}
      {tree.loose.map((c) => (
        <option key={c} value={c}>{c}</option>
      ))}
    </>
  );
}
