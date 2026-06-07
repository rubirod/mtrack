import type { ClassifyConfig, CounterpartyRule, MerchantRule, RuleField } from './categories';
import type { Category } from './types';
import type { SheetsAPI } from './sheets-api';

/**
 * Reads 3 config tabs and assembles a `ClassifyConfig`.
 *
 * All categories, mappings and rules live in the spreadsheet — only the
 * shapes live in code (see `categories.ts`). Tabs are seeded by
 * `seedConfigTabs(api)` on first launch. A missing tab yields an empty
 * section; the corresponding classification step then silently falls
 * through to `source=manual`.
 */
export async function loadClassifyConfig(api: SheetsAPI): Promise<ClassifyConfig> {
  const [bankMap, merchantRows, counterpartyRows] = await Promise.all([
    safeRead(api, 'bank_category_map!A2:B'),
    safeRead(api, 'merchant_rules!A2:B'),
    safeRead(api, 'counterparty_rules!A2:G'),
  ]);

  const bankCategoryMap = new Map<string, Category>();
  for (const row of bankMap) {
    const [bank, cat] = row;
    if (bank && cat) bankCategoryMap.set(bank, cat);
  }

  const merchantRules: MerchantRule[] = [];
  for (const row of merchantRows) {
    const [match, category] = row;
    if (match && category) merchantRules.push({ match, category });
  }

  const counterpartyRules: CounterpartyRule[] = [];
  for (const row of counterpartyRows) {
    const [match, kind, label, category, suggest, excluded, field] = row;
    if (!match || !kind || !label) continue;
    if (kind !== 'transfer' && kind !== 'income' && kind !== 'peer') {
      console.warn(`counterparty_rules: unknown kind=${kind} for match=${match}, skipped`);
      continue;
    }
    counterpartyRules.push({
      match,
      kind,
      label,
      category: category || undefined,
      suggest: isTrue(suggest),
      excluded: isTrue(excluded),
      field: parseField(field),
    });
  }

  return { bankCategoryMap, merchantRules, counterpartyRules };
}

async function safeRead(api: SheetsAPI, range: string): Promise<string[][]> {
  try {
    return await api.getValues(range);
  } catch {
    // Fresh sheet without config tabs — return empty.
    return [];
  }
}

function isTrue(v: string | undefined): boolean {
  if (!v) return false;
  return v.toLowerCase() === 'true';
}

function parseField(v: string | undefined): RuleField | undefined {
  if (v === 'bankCategory' || v === 'description') return v;
  return undefined;
}
