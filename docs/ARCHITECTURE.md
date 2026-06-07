# Architecture

## 1. Stack

- TypeScript end to end.
- PWA on React + Vite + vite-plugin-pwa. Desktop browser and iPhone
  ("Add to Home Screen") share the same build.
- Google Sheets as the source of truth for both operations and the
  classification configuration.
- Claude API called directly from the browser for category suggestions
  and vision-based parsing.
- Google Identity Services for user OAuth. No service account, no Node CLI.
- pnpm workspaces.

## 2. Layout

```
mtrack/
├── packages/
│   └── core/        @mtrack/core — isomorphic core
│       └── src/
│           ├── types.ts            Operation, ClassifiedOperation, kind
│           ├── categories.ts       ClassifyConfig + rule shapes
│           ├── classify.ts         layer 1: single-pass classifier
│           ├── sheets-api.ts       SheetsAPI port (DI)
│           ├── config-loader.ts    reads config tabs into ClassifyConfig
│           ├── operations-store.ts idempotent upsert into `operations`
│           ├── seed-defaults.ts    default seed for fresh sheets
│           └── sources/
│               ├── csv-statement.ts  CSV → Operation[]
│               └── pdf-statement.ts  StatementDocument → Operation[]
└── apps/
    └── web/         @mtrack/web — PWA
        └── src/
            ├── google.ts        SheetsAPI impl (fetch + GIS)
            ├── settings.ts      localStorage: keys + spreadsheet ID
            ├── Settings.tsx     first-launch screen, seed button
            ├── Import.tsx       statement import flow
            └── App.tsx          tabs (Import / Confirm / Cash / Receipt / More)
```

No backend. All computation in the browser; all secrets in `localStorage`.
The spreadsheet is the only server-side component, and it belongs to the user.

## 3. Data flow

```
┌───────────────────────────────┐        ┌─────────────────────────┐
│  apps/web (PWA, React)        │        │ Google Sheets           │
│                               │        │ (source of truth)       │
│  - Statement import           │◀──────▶│                         │
│  - Tap-confirm                │        │  operations             │
│  - Cash entry                 │        │  categories             │
│  - Receipt vision             │        │  bank_category_map      │
│  - Dashboard browsing         │        │  merchant_rules         │
└───────────────┬───────────────┘        │  counterparty_rules     │
                │                        │  accounts               │
                ▼                        │  balances / monthly     │
        packages/core                    └─────────────────────────┘
   Parsers, classifier, store, seed.
   Isomorphic: the same code runs in
   the browser and (eventually) on a
   future Node backend.
```

When a backend is needed (email-based import, Telegram bot, cron),
it will live under `apps/server/` and consume the same `@mtrack/core`
through a Node-backed `SheetsAPI` implementation.

## 4. Operation model

Every channel normalizes inputs into `Operation` (see `core/src/types.ts`).
The classifier turns it into `ClassifiedOperation`, assigning a movement
kind (`OperationKind`):

- **expense** — outflow at a merchant; gets a category.
- **income** — inflow from outside (salary, interest, cashback).
- **transfer** — movement between own accounts (cards, brokerage, cash).
- **peer** — transfer to/from another person; sign indicates direction.

This split matters: spending and account-to-account movements both need
to be visible. Cash withdrawals, brokerage top-ups and card-to-card
transfers are not expenses and are not lost — they show up under
"Transfers".

`ClassifiedOperation` carries two flags:

- **`needsConfirmation`** — category was set by a rule but as a guess;
  the UI surfaces these for one-tap confirm/change.
- **`excluded`** — kept in data but ignored in aggregates.

## 5. Classification — layers

Only `expense` operations get categorized. Layers, from cheap to
expensive (only layer 1 is implemented today):

1. **Layer 1 — deterministic.** Single pass:
   - Counterparty rules (match description or bank category) decide
     transfers, incomes and peer transfers.
   - Otherwise → expense; category from merchant rules then from the
     bank-category map.
2. **Layer 2 — AI for the leftover.** Cheap model for unknown merchants.
   Not implemented.
3. **Layer 3 — AI vision.** Receipt splitting by category.
   Not implemented.

The bank's category is a hint, never the truth. "Supermarket" might hold
both food and household goods. Layer 3 will eventually split a single
receipt across categories.

## 6. Isomorphism

`@mtrack/core` doesn't depend on Node APIs. Parsers are plain TypeScript;
the store works against the `SheetsAPI` interface. This lets us:

- keep everything in the browser today;
- add a server channel (IMAP import, bot, cron) tomorrow without
  rewriting the core.

## 7. Statement sources

Each channel is a module under `core/src/sources/` that turns a bank
format into `Operation[]`. From there everything is the same:
`classify(op, config)` → push.

| Channel | Format | Implementation | Status |
| ------- | ------ | -------------- | ------ |
| `csv` | CSV | TS-native parser | implemented |
| `pdf` | PDF | Claude vision → StatementDocument | TODO (vision) |

`pdf-statement.ts` already knows how to map a `StatementDocument` into
`Operation[]`. What remains is teaching vision to produce that shape
from a PDF.

## 8. What's deferred

- Layer 2 (AI for unknown merchants) and Layer 3 (receipt vision).
- Server-side import channels (email, bot, cron) under `apps/server/`.
- iOS-native client — PWA via "Add to Home Screen" is enough until push
  notifications and native camera access become required.
- Currency normalization to a base currency.
