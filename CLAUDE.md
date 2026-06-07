# CLAUDE.md — notes for future Claude sessions

## What this is

Personal finance tracker. A single PWA (`apps/web`) that imports bank
statements, classifies operations with user-defined rules, and upserts
them into the user's own Google Sheet. No backend. All secrets stay in
the browser's `localStorage`; the sheet is the only "server".

## Stack

- TypeScript across the repo. pnpm workspaces.
- `apps/web` — React + Vite + vite-plugin-pwa. Deployed to GitHub Pages.
- `packages/core` — isomorphic: pure TS, no Node imports. Reused as-is
  in the browser; ready to be reused in a future `apps/server`.
- Google Sheets via `https://sheets.googleapis.com/v4` REST + Google
  Identity Services (user OAuth). No service account.
- Claude API called directly from the browser
  (`@anthropic-ai/sdk` with `dangerouslyAllowBrowser`).
- Google OAuth Client ID is **baked into the build** via
  `VITE_GOOGLE_CLIENT_ID` (set in CI via repo variable `GOOGLE_CLIENT_ID`).
  Public by design; Authorized JavaScript origins on the OAuth client
  restrict its use to the deployed PWA origin. The Client Secret is never
  used in browser flow. Per-user secrets (Anthropic key, spreadsheet ID)
  stay in `localStorage`.

## Layout

```
packages/core/src/
  types.ts            Operation, ClassifiedOperation, OperationKind
  categories.ts       ClassifyConfig + rule shapes (Merchant, Counterparty)
  classify.ts         single-pass classifier (rules → expense fallback)
  sheets-api.ts       SheetsAPI port (interface)
  config-loader.ts    reads 3 config tabs into ClassifyConfig
  operations-store.ts idempotent upsert + reclassifyAll over `operations`
  seed-defaults.ts    populates config tabs on first launch
  sources/
    csv-statement.ts  CSV → Operation[]
    pdf-statement.ts  StatementDocument → Operation[]

apps/web/src/
  google.ts        createSheetsAPI() — implements core's SheetsAPI port
  settings.ts      localStorage-backed Settings shape
  Settings.tsx     first-launch screen + seed-config button
  Import.tsx       statement import flow
  App.tsx          tab shell (Import / Confirm / Cash / Receipt / More)
```

The `Confirm`, `Cash`, `Receipt` tabs are placeholders today.

## Key conventions

- **English only.** No Cyrillic anywhere — comments, strings, identifiers,
  docs, commit messages. Verify with
  `git ls-files | xargs grep -lP '[\x{0400}-\x{04FF}]'`.
- **No bank names anywhere.** Public repo doesn't reveal which banks
  the user uses. Parsers are described by format (CSV / PDF), not by
  bank. Don't use Tinkoff, T-Bank, Freedom, Sber, etc. in code or docs.
- **No personal data.** No API keys, no spreadsheet IDs, no real names,
  no CSV/PDF fixtures with the user's transactions. `.env*` and
  `private/` are gitignored — keep them so.
- **Data-driven classifier.** Anything bank-specific (cash-withdrawal
  label, interest income label, transfer destinations) is a row in
  `counterparty_rules` in the sheet — not a hardcoded branch in
  `classify.ts`. Rule shape allows matching against either `description`
  or `bankCategory` (via the `field` column).
- **Isomorphism.** `packages/core` must not import `node:*` or pull in
  `googleapis`. Use Web Crypto (`crypto.subtle`) instead of `node:crypto`.
  Use the `SheetsAPI` interface, never a concrete client.
- **Idempotent writes.** `operationId()` is a stable SHA-1 over
  (occurredAt, amount, description, account, sourceChannel). Re-importing
  an overlapping statement updates rows, never duplicates.
- **`manualOverride` is sacred.** Listed fields are NEVER overwritten by
  imports.
- **Two account levels.** `operations.account` is the raw bank instrument
  (card tail); `operations.accountName` is the canonical balance. The
  `balances` tab is the flat canon (name, currency, type, archived); the
  `accounts` tab routes instruments → balances (`sourceChannel | tail |
  balance`, many-to-one, empty tail = channel default). Balances without a
  bank instrument (cash, savings/ПДС, brokerage) live in `balances` only and
  are fed by transfers (counterparty) or manual entry. One bank can own many
  balances.
- **Categories are hierarchical.** `categories` tab is `name | parent`.
  Operations always store the leaf name; parent is for grouping in reports.

## Sheet tabs

`balances`, `accounts`, `categories`, `bank_category_map`, `merchant_rules`,
`counterparty_rules` (config, seeded), `operations` (data, created by import).
`reclassifyAll` re-runs rules over existing `operations` rows without a
re-import (Rules tab → "Apply now").

## Commands

```bash
pnpm install
pnpm typecheck                       # type-check whole repo
pnpm build                           # build all packages
pnpm --filter @mtrack/web dev        # dev server on :5173/mtrack/
pnpm --filter @mtrack/web build      # production PWA build
```

## Solo-dev workflow

This is a solo repo with a single squashed/amended `Initial commit` on
`main`. Until first public release it's acceptable to:

- amend `main` and `git push -f`, keeping history tidy;
- collapse changes into the initial commit rather than stacking many
  small ones.

After the first public release announce, **stop amending** and use
normal additive commits.

## Things that often need re-checking before merging

- `git ls-files | xargs grep -lP '[\x{0400}-\x{04FF}]'` → must be empty.
- `git ls-files | xargs grep -inE 'tinkoff|t-?bank|tbank|freedom|sber|raiffeisen|yandex|ryabuk|vyacheslav|vasil'`
  → must be empty (outside `pnpm-lock.yaml`).
- `pnpm typecheck` and `pnpm --filter @mtrack/web build` green.
- No `.env`, no `private/`, no real statements committed.

## What's deferred

- Layer 2 (AI category suggestion for unmatched merchants) and Layer 3
  (Claude vision splitting a receipt across categories).
- PDF statement parsing — `parsePdfStatement` already maps
  `StatementDocument → Operation[]`; what's missing is the PWA-side
  vision call that turns a PDF file into a `StatementDocument`.
- `apps/server/` — would consume the same `@mtrack/core` for IMAP /
  Telegram / cron channels.
- **Cash tab** — manual expense entry. Should also support *balance
  adjustment*: user enters a desired balance, the app inserts an operation
  for the diff (category "Balance adjustment"). This is just sugar over a
  normal manual operation, the way Money Pro does it.
- **Backup import** — one-off migration from a Money Pro `.back` file
  (custom `name\nlength\nbytes` container wrapping a SQLite db). Imports
  balances, categories (with parent), and transactions. Money Pro model:
  `transactions` (date = Unix epoch, sum always positive), sign from
  `category.flowType` (1=income, 2=expense), `transactionType=2` = transfer
  with `secondCashFlowPrimaryKey` = destination balance, `splitTransaction`
  links one txn to one-or-more categories. Parse SQLite in-browser via
  lazily-loaded sql.js (WASM), push through `pushOperations`.

## Mobile latency for manual entry — design rule

`pushOperations` reads the entire `operations` tab on every call to ensure
idempotency by id-collision detection. That's fine for batch imports (rare,
overlapping CSV/PDF/backup files) but **unacceptable for single manual ops
on mobile** once the sheet grows beyond ~10K rows.

When implementing the **Cash** tab and **Confirm** tab, do NOT route through
`pushOperations`. Add a separate fast path:

- `appendManualOperation(api, op)` — loads only `accounts` (tiny), assigns a
  unique `sourceId` (timestamp/uuid), `appendValues` once. Constant time,
  no read of `operations`.
- For Confirm-tap (updating an existing row's `category` / `kind` /
  `manualOverride`), use `updateOperationFields(api, id, patch)` — read
  only the row with that id (via `getValues` of one column range to find
  rowNum, then update that single row).

Idempotency for manual ops is the user's responsibility (disable submit
button on click); they don't need collision-checked id space. Keep this
separation: `pushOperations` for batch, single-op helpers for interactive.
