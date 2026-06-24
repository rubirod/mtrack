/**
 * Defaults used on first sheet setup. Generic and example-only — every user
 * should edit them in the spreadsheet right after seeding. Nothing personal,
 * nothing bank-specific.
 *
 * Triggered from the PWA settings screen via "Seed config tabs".
 */

import type { Row, SheetsAPI } from './sheets-api';

// [name, parent]. A blank parent means a top-level category. Subcategories
// reference their parent by name; operations always store the leaf name.
const DEFAULT_CATEGORIES: Array<[string, string]> = [
  ['Food', ''],
  ['Home', ''],
  ['Health', ''],
  ['Transport', ''],
  ['Lifestyle', ''],
  ['Shopping', ''],
  ['Travel', ''],
  ['Subscriptions', ''],
];

// Canonical accounts (flat). Currency lives on the balance for future
// base-currency reporting. `type` is a free hint: card / savings / cash /
// brokerage. Empty by default — seeded from a backup import or by hand.
const DEFAULT_BALANCES: Row[] = [
  // ['Main', 'USD', 'card', ''],
];

const DEFAULT_BANK_CATEGORY_MAP: Row[] = [
  // Empty by default. Add rows like ["Groceries", "Food"] to map your bank's
  // category names to your user categories.
];

const DEFAULT_MERCHANT_RULES: Row[] = [
  // Examples. The substring is matched case-insensitively against the
  // operation description.
  ['netflix', 'Subscriptions'],
  ['spotify', 'Subscriptions'],
];

const DEFAULT_COUNTERPARTY_RULES: Row[] = [
  // columns: match, kind, label, category, suggest, excluded, field
  ['internal transfer', 'transfer', 'Internal transfer', '', '', '', 'description'],
  ['brokerage', 'transfer', 'Brokerage', '', '', '', 'description'],
  ['savings', 'transfer', 'Savings', '', '', '', 'description'],
  ['cash withdrawal', 'transfer', 'Cash', '', '', '', 'description'],
  ['interest', 'income', 'Interest', '', '', '', 'bankCategory'],
  ['cashback', 'income', 'Cashback', '', '', '', 'bankCategory'],
];

interface TabSpec {
  name: string;
  headers: string[];
  rows: Row[];
}

const SEED_TABS: TabSpec[] = [
  {
    name: 'categories',
    headers: ['name', 'parent'],
    rows: DEFAULT_CATEGORIES.map(([name, parent]) => [name, parent] as Row),
  },
  {
    name: 'balances',
    headers: ['name', 'currency', 'type', 'archived'],
    rows: DEFAULT_BALANCES,
  },
  {
    name: 'accounts',
    headers: ['sourceChannel', 'tail', 'balance'],
    rows: [],
  },
  {
    name: 'bank_category_map',
    headers: ['bankCategory', 'category'],
    rows: DEFAULT_BANK_CATEGORY_MAP,
  },
  {
    name: 'merchant_rules',
    headers: ['match', 'category', 'bankCategory'],
    rows: DEFAULT_MERCHANT_RULES,
  },
  {
    name: 'counterparty_rules',
    headers: ['match', 'kind', 'label', 'category', 'suggest', 'excluded', 'field', 'tail'],
    rows: DEFAULT_COUNTERPARTY_RULES,
  },
];

/**
 * Creates the config tabs if they don't exist yet, and fills them with
 * default values. Existing tabs are left alone.
 */
export async function seedConfigTabs(api: SheetsAPI): Promise<{ created: string[] }> {
  const existing = new Set(await api.listTabs());
  const created: string[] = [];

  for (const tab of SEED_TABS) {
    if (existing.has(tab.name)) continue;
    await api.ensureTab(tab.name);
    await api.updateValues(`${tab.name}!A1`, [tab.headers as Row, ...tab.rows]);
    created.push(tab.name);
  }

  return { created };
}
