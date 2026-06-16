import type { Category, OperationKind } from './types';

/**
 * Categories and classification rules live outside the codebase, in Google
 * Sheets. This module only declares the shapes; the engine reads sheets at
 * startup and builds a `ClassifyConfig` to pass into `classify()`.
 *
 * Sheets (seeded by `seedConfigTabs(api)` on first launch):
 *
 *  - `categories`           — A=name. List of user categories.
 *  - `bank_category_map`    — A=bankCategory, B=category. Maps the bank's
 *                             category to the user's user category for
 *                             expenses.
 *  - `merchant_rules`       — A=match, B=category. Point rules by substring
 *                             of the operation description.
 *  - `counterparty_rules`   — A=match, B=kind, C=label, D=category,
 *                             E=suggest, F=excluded, G=field, H=tail. Rules
 *                             for transfers, incomes and peer transfers; rule
 *                             order matters, first match wins.
 */

export interface MerchantRule {
  /** Substring of the description, matched case-insensitively. */
  match: string;
  category: Category;
}

export type RuleField = 'description' | 'bankCategory';

export interface CounterpartyRule {
  /** Substring to match (case-insensitive). */
  match: string;
  /** Field to match against; defaults to 'description'. */
  field?: RuleField;
  kind: Extract<OperationKind, 'transfer' | 'income' | 'peer'>;
  /** Human-readable counterparty label used in reports. */
  label: string;
  /** Suggested category when the transfer has an obvious purpose. */
  category?: Category;
  /** true → category is a suggestion, awaiting user tap-confirm. */
  suggest?: boolean;
  /** true → operation is kept in data but excluded from aggregates. */
  excluded?: boolean;
  /** When set, the rule only applies to operations on this card tail. Lets a
   * rule be scoped to one instrument (e.g. exclude cash-outs from one card). */
  tail?: string;
}

/**
 * Configuration consumed by `classify()`. Fully user-defined, loaded from
 * the spreadsheet. `bankCategoryMap` is a Map for O(1) lookup. Rule order
 * matters within each list — the first match wins.
 */
export interface ClassifyConfig {
  bankCategoryMap: ReadonlyMap<string, Category>;
  merchantRules: readonly MerchantRule[];
  counterpartyRules: readonly CounterpartyRule[];
}
