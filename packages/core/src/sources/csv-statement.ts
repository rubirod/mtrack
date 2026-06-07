import type { Operation } from '../types';

/**
 * Parses a single CSV line: semicolon-separated, double-quoted fields,
 * embedded quotes escaped by doubling ("").
 */
function parseCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      fields.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

/** Comma decimal, optional spaces as thousand separators: "-1 234,56" → -1234.56. */
function parseAmount(s: string): number {
  return parseFloat(s.replace(/\s/g, '').replace(',', '.'));
}

/**
 * Collapses any whitespace (including non-breaking) into a single space and
 * trims. Some bank exports mix regular spaces with U+00A0 in category names;
 * without normalization a category key won't match the map.
 */
function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * CSV statement parser.
 *
 * Expected schema (column indices):
 *   0  transaction datetime ("DD.MM.YYYY HH:MM:SS")
 *   2  card / account tail (e.g. "*1234")
 *   3  status (only rows with status "OK" are kept)
 *   5  transaction currency
 *   6  posted amount (signed)
 *   9  bank-provided category
 *  10  MCC
 *  11  description / merchant
 *
 * Delimiter ';', strings are double-quoted. Map your bank's column order to
 * this shape, or add another parser if it differs.
 */
export function parseCsvStatement(text: string): Operation[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const ops: Operation[] = [];

  for (let i = 1; i < lines.length; i += 1) {
    const f = parseCsvLine(lines[i]!, ';');
    if (f.length < 12 || f[3] !== 'OK') continue;

    const [date, time] = f[0]!.split(' ');
    const card = f[2]!.replace('*', '').trim();

    ops.push({
      date: date ?? f[0]!,
      time: time ?? null,
      account: card || null,
      amount: parseAmount(f[6]!),
      currency: norm(f[5]!),
      bankCategory: norm(f[9]!),
      mcc: norm(f[10]!) || null,
      description: norm(f[11]!),
    });
  }
  return ops;
}
