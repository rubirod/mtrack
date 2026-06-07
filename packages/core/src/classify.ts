import type { ClassifiedOperation, Operation } from './types';
import type { ClassifyConfig } from './categories';

/**
 * Layer 1 — deterministic classification of a single operation.
 *
 * Single-pass model, fully data-driven by `ClassifyConfig` loaded from the
 * spreadsheet (see `categories.ts`):
 *
 *  1. Walk counterparty rules in order. Each rule matches a substring of
 *     either the description (default) or the bank-provided category. The
 *     first match wins and assigns kind + label + optional category and
 *     suggest/excluded flags.
 *  2. Otherwise — expense. Look up a category, first via merchant rules
 *     (substring of description), then via the bank-category map.
 *
 * No hardcoded bank vocabulary. Anything bank-specific (cash-withdrawal
 * label, interest income label, transfer to brokerage, etc.) is expressed
 * as a row in `counterparty_rules` or `bank_category_map`.
 */
export function classify(op: Operation, config: ClassifyConfig): ClassifiedOperation {
  const desc = op.description.toLowerCase();
  const bank = op.bankCategory;
  const bankLower = bank.toLowerCase();

  for (const rule of config.counterpartyRules) {
    const haystack = rule.field === 'bankCategory' ? bankLower : desc;
    if (haystack.includes(rule.match.toLowerCase())) {
      return {
        ...op,
        kind: rule.kind,
        category: rule.category ?? null,
        counterparty: rule.label,
        source: 'rule',
        needsConfirmation: rule.suggest ?? false,
        excluded: rule.excluded ?? false,
      };
    }
  }

  // Expense path. Merchant rules override the bank-category map for cases
  // where the bank's bucket is too generic ("Other", "Misc") but the
  // merchant is recognisable.
  const merchantRule = config.merchantRules.find((r) => desc.includes(r.match.toLowerCase()));
  const category = merchantRule?.category ?? config.bankCategoryMap.get(bank) ?? null;
  return {
    ...op,
    kind: 'expense',
    category,
    counterparty: null,
    source: category ? 'rule' : 'manual',
    needsConfirmation: false,
    excluded: false,
  };
}
