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
// Receipts need vision + a bit more reasoning than the merchant classifier.
const VISION_MODEL = 'claude-sonnet-4-6';

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

export interface ReceiptItem {
  description: string;
  amount: number; // positive line price
  category: string; // one of the user's categories, or '' if unsure
}

export interface ParsedReceipt {
  merchant: string;
  date: string; // DD.MM.YYYY or ''
  currency: string; // ISO-ish (RUB/USD/…) or ''
  items: ReceiptItem[];
}

/**
 * Layer 3 — split a receipt photo into per-item operations. Claude reads the
 * image and returns the merchant, date, currency and one line per purchased
 * item, each pre-assigned a category from the user's own list.
 */
export async function parseReceipt(
  apiKey: string,
  imageBase64: string,
  mediaType: ImageMediaType,
  categories: string[],
): Promise<ParsedReceipt> {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const allowed = new Set(categories);

  const prompt = [
    'Read this shop receipt and split it into the individual purchased items.',
    'Return ONLY JSON, no prose, in this exact shape:',
    '{"merchant":"<store name>","date":"<DD.MM.YYYY or empty>","currency":"<ISO code like RUB/USD or empty>",',
    ' "items":[{"description":"<item name>","amount":<positive number>,"category":"<one category>"}]}',
    '',
    'Rules:',
    '- One entry per purchased line item; merge a quantity into its line (amount = line total).',
    '- Skip subtotal, tax, discount and grand-total lines.',
    '- amount is a positive number (the price paid for that item), no currency symbol.',
    '- category MUST be exactly one of this list (pick the best fit, else ""):',
    categories.join(', '),
  ].join('\n');

  const resp = await client.messages.create({
    model: VISION_MODEL,
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: prompt },
        ],
      },
    ],
  });

  const text = resp.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();

  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const parsed = JSON.parse(json) as Partial<ParsedReceipt>;
  const items: ReceiptItem[] = (parsed.items ?? [])
    .filter((it) => it && it.description && Number.isFinite(Number(it.amount)))
    .map((it) => ({
      description: String(it.description),
      amount: Math.abs(Number(it.amount)),
      category: it.category && allowed.has(it.category) ? it.category : '',
    }));

  return {
    merchant: String(parsed.merchant ?? ''),
    date: String(parsed.date ?? ''),
    currency: String(parsed.currency ?? ''),
    items,
  };
}

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
