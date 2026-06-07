/**
 * Clusters a free-form operation description into a stable "merchant key".
 *
 * The bank prints descriptions like "ПЯТЁРОЧКА 5689" or "Wildberries #15689" —
 * the trailing numbers are store/branch codes that vary per location. We
 * normalize to make all occurrences of the same merchant cluster together,
 * so the Merchant breakdown UI can show one row per merchant and write a
 * single `merchant_rules` row that catches them all.
 *
 * Algorithm:
 *  - lowercase + Unicode-aware letter/digit filtering;
 *  - strip trailing numeric codes;
 *  - collapse whitespace;
 *  - keep the first two words, capped at 24 characters.
 *
 * The result is also a usable substring match against the original
 * description (because the bank prints the merchant name first).
 */
export function clusterMerchant(description: string): string {
  let s = description.toLowerCase();
  // Replace non-letter/non-digit chars (Unicode-aware) with spaces.
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  // Strip trailing numeric codes (with optional surrounding whitespace).
  s = s.replace(/\s*\d+\s*$/, '');
  // Collapse whitespace.
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const head = s.split(' ').slice(0, 2).join(' ');
  return head.slice(0, 24);
}
