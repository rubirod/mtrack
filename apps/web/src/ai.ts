/**
 * Layer 2 — AI category suggestion for merchants no deterministic rule matched.
 *
 * Called from the Confirm tab. Given a batch of unknown merchants and the
 * user's own category list, Claude picks the best-fit existing category for
 * each. The model is constrained to the supplied list (we drop anything it
 * invents), so a suggestion is always a real category the user can accept.
 *
 * Runs in the browser against the user's own Anthropic key (the same
 * dangerouslyAllowBrowser path the rest of the app uses).
 */
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-haiku-4-5-20251001';

export interface MerchantToClassify {
  merchant: string;
  bankCategory?: string;
}

/** merchant → suggested category. Missing keys mean "no confident suggestion". */
export async function suggestCategories(
  apiKey: string,
  items: MerchantToClassify[],
  categories: string[],
): Promise<Record<string, string>> {
  if (items.length === 0 || categories.length === 0) return {};

  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const allowed = new Set(categories);

  const prompt = [
    'You categorise bank-statement merchants for a personal finance tracker.',
    'Pick the single best-fit category for each merchant, chosen ONLY from this list:',
    categories.join(', '),
    '',
    'Merchants (with the bank-provided category as a hint):',
    ...items.map((it, i) => `${i + 1}. "${it.merchant}"${it.bankCategory ? ` [bank: ${it.bankCategory}]` : ''}`),
    '',
    'Reply with ONLY a JSON array, no prose, like:',
    '[{"merchant":"<exact merchant text>","category":"<one category from the list>"}]',
    'Omit a merchant entirely if none of the categories fit.',
  ].join('\n');

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = resp.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();

  const out: Record<string, string> = {};
  try {
    const json = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
    const parsed = JSON.parse(json) as Array<{ merchant?: string; category?: string }>;
    for (const row of parsed) {
      if (row.merchant && row.category && allowed.has(row.category)) {
        out[row.merchant] = row.category;
      }
    }
  } catch {
    // Model returned something unparseable — treat as no suggestions.
  }
  return out;
}
