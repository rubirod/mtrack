/**
 * Channel-neutral interface for working with a Google spreadsheet.
 *
 * Implemented in the PWA over fetch + Google Identity Services (user OAuth).
 * A future server-side backend would implement it over googleapis under Node.
 * `@mtrack/core` only depends on this interface and never imports `googleapis`
 * directly — otherwise it would pull Node-only deps into the browser.
 */

export type Cell = string | number | boolean | null;
export type Row = Cell[];

export interface ValueRange {
  range: string;
  values: Row[];
}

export interface SheetsAPI {
  /** Read a range. Returns rows of strings; empty cells become ''. */
  getValues(range: string): Promise<string[][]>;

  /** Overwrite a range. */
  updateValues(range: string, values: Row[]): Promise<void>;

  /** Append to the end of a sheet; `range` is normally 'tab!A:Z'. */
  appendValues(range: string, values: Row[]): Promise<void>;

  /** Several updates in a single HTTP request. */
  batchUpdateValues(data: ValueRange[]): Promise<void>;

  /** Titles of all tabs in the spreadsheet. */
  listTabs(): Promise<string[]>;

  /** Create an empty tab if it doesn't exist yet. */
  ensureTab(title: string): Promise<void>;

  /** Clear all values in a range. Headers usually stay in row 1, so the
   * typical range is `tab!A2:Z`. */
  clearRange(range: string): Promise<void>;
}
