/**
 * Folding the merchant editor's picks into the existing rule tabs.
 *
 * The editor sees one narrow slice of the rules: a merchant string, and what
 * the user wants it to mean. The tabs hold more than that — `merchant_rules`
 * may scope a rule to a bank category (the same merchant meaning different
 * things in different buckets), and `counterparty_rules` may scope one to a
 * card tail. Two rules can therefore share a match string and differ only by
 * that scope.
 *
 * Folding the picks through a Map keyed on the match string collapses exactly
 * those pairs, and rewriting the tab from a column subset drops the scope
 * column outright — both silently, both destroying user intent. So this works
 * on the rows as read, in their original order: a pick only ever touches the
 * *unscoped* rule for that match, and every scoped rule passes through
 * untouched. Order matters as well — `counterparty_rules` is first-match-wins.
 */

export interface MerchantRuleRow {
  match: string;
  category: string;
  /** Bank category the rule is narrowed to; '' = applies to every bucket. */
  bankCategory: string;
}

export interface CounterpartyRuleRow {
  match: string;
  kind: 'transfer' | 'income' | 'peer';
  label: string;
  category: string;
  suggest: string;
  excluded: string;
  field: string;
  /** Card tail the rule is scoped to; '' = applies to every instrument. */
  tail: string;
}

/**
 * One merchant decision, encoded the way the editor stores it:
 * `exp:<category>` | `trf:<balance>` | `peer` | `inc`.
 */
export interface MerchantPick {
  merchant: string;
  picked: string;
}

export interface MergedRules {
  merchantRules: MerchantRuleRow[];
  counterpartyRules: CounterpartyRuleRow[];
}

/** Index of the unscoped rule for `match`, or -1. Scoped rules are never touched. */
function findUnscopedMerchant(rows: MerchantRuleRow[], match: string): number {
  return rows.findIndex((r) => r.match === match && !r.bankCategory);
}

function findUnscopedCp(rows: CounterpartyRuleRow[], match: string): number {
  return rows.findIndex((r) => r.match === match && !r.tail);
}

export function mergeMerchantPicks(
  existingMerchant: readonly MerchantRuleRow[],
  existingCp: readonly CounterpartyRuleRow[],
  picks: readonly MerchantPick[],
): MergedRules {
  const merchantRules = existingMerchant.map((r) => ({ ...r }));
  const counterpartyRules = existingCp.map((r) => ({ ...r }));

  const dropUnscopedMerchant = (match: string): void => {
    const i = findUnscopedMerchant(merchantRules, match);
    if (i >= 0) merchantRules.splice(i, 1);
  };
  const dropUnscopedCp = (match: string): void => {
    const i = findUnscopedCp(counterpartyRules, match);
    if (i >= 0) counterpartyRules.splice(i, 1);
  };
  const upsertCp = (row: CounterpartyRuleRow): void => {
    const i = findUnscopedCp(counterpartyRules, row.match);
    if (i >= 0) counterpartyRules[i] = row;
    else counterpartyRules.push(row);
  };

  for (const { merchant, picked } of picks) {
    const pick = picked.trim();
    if (!merchant || !pick) continue;

    if (pick.startsWith('exp:')) {
      const category = pick.slice(4);
      const i = findUnscopedMerchant(merchantRules, merchant);
      if (i >= 0) merchantRules[i] = { ...merchantRules[i]!, category };
      else merchantRules.push({ match: merchant, category, bankCategory: '' });
      // A counterparty rule on the same string would win over the merchant
      // rule, so the expense pick replaces it.
      dropUnscopedCp(merchant);
      continue;
    }

    const base = {
      match: merchant,
      category: '',
      suggest: '',
      excluded: '',
      field: 'description',
      tail: '',
    };
    if (pick.startsWith('trf:')) {
      upsertCp({ ...base, kind: 'transfer', label: pick.slice(4) });
    } else if (pick === 'peer') {
      upsertCp({ ...base, kind: 'peer', label: merchant });
    } else if (pick === 'inc') {
      upsertCp({ ...base, kind: 'income', label: merchant });
    } else {
      continue; // unknown encoding — leave the tabs alone
    }
    dropUnscopedMerchant(merchant);
  }

  return {
    merchantRules: merchantRules.filter((r) => r.match && r.category),
    counterpartyRules: counterpartyRules.filter((r) => r.match && r.kind && r.label),
  };
}
