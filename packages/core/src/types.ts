/**
 * User category name — a free-form string defined in the spreadsheet
 * (`categories` tab). Source of truth is the sheet, not the codebase:
 * categories are edited directly in the sheet without redeploy.
 */
export type Category = string;

/**
 * Movement type of an operation.
 *
 *  - expense  — outflow at a merchant (consumption); receives a category.
 *  - income   — inflow from outside (salary, interest, cashback).
 *  - transfer — movement between own accounts (cards, brokerage, cash).
 *  - peer     — transfer to/from another person; sign indicates direction.
 *               A category may be assigned optionally (e.g. allowance).
 */
export type OperationKind = 'expense' | 'income' | 'transfer' | 'peer';

/**
 * Raw operation as produced by any channel parser (CSV, PDF, manual entry).
 * Channel-neutral: downstream classification doesn't care where it came from.
 */
export interface Operation {
  date: string; // DD.MM.YYYY
  time: string | null; // HH:MM:SS
  account: string | null; // last 4 digits of card / account
  amount: number; // signed; expenses are negative
  currency: string;
  bankCategory: string; // category as printed by the bank
  mcc: string | null;
  description: string;
}

/**
 * Operation after the classifier (layer 1). Adds:
 *  - kind     — see OperationKind;
 *  - category — user category (only for expense, optionally for peer/income
 *               as a suggestion);
 *  - counterparty — other side: account name or person, for transfer/peer/income;
 *  - source   — how `category` was assigned (rule / manual / ai);
 *  - needsConfirmation — true means "we guessed, awaiting user tap"
 *                        (set by rules with suggest=true);
 *  - excluded — true means "don't aggregate this in reports".
 */
export interface ClassifiedOperation extends Operation {
  kind: OperationKind;
  category: Category | null;
  counterparty: string | null;
  source: 'rule' | 'manual' | 'ai';
  needsConfirmation: boolean;
  excluded: boolean;
  /**
   * Optional stable identifier from the source channel (e.g. Money Pro
   * primaryKey:splitIndex). When set, it's mixed into the operation id so
   * re-imports stay idempotent even when (date, amount, description,
   * account) wouldn't uniquely identify the row. CSV imports don't set it
   * and keep the legacy id space.
   */
  sourceId?: string;
}
