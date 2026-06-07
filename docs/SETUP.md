# Setup

mtrack runs entirely in the browser. Google Sheets stores both operations
and configuration. The deploy bakes a Google OAuth Client ID into the
build; each user only enters two values on first launch.

## For the deploy maintainer (once)

You need to do this once per deploy of the PWA (e.g. when forking and
hosting your own copy under `https://<you>.github.io/mtrack/`).

### 1. Google Cloud project

At [console.cloud.google.com](https://console.cloud.google.com): New
Project → any name.

Inside the project:

- **APIs & Services → Library** → enable **two** APIs:
  - **Google Sheets API** — for reading/writing the spreadsheet.
  - **Google Drive API** — for listing the user's sheets in the picker
    (uses `drive.metadata.readonly` scope).
- **Google Auth Platform → Overview** → Create:
  - **Audience**: External.
  - **App information**: name "mtrack", your email as support and developer.
  - **Test users**: every Gmail that will use this deploy (you, your spouse,
    etc). Unverified apps cap at 100 lifetime test users, but each test user
    is added explicitly here — random visitors can't fill the slot.
- **Google Auth Platform → Clients → Create client**:
  - Application type: **Web application**.
  - Authorized JavaScript origins:
    - `https://<your-github>.github.io` (production deploy)
    - `http://localhost:5173` (local dev)
  - Copy the Client ID (ends with `.apps.googleusercontent.com`).

### 2. GitHub: set the Client ID as a repo variable

Repo → Settings → Secrets and variables → Actions → **Variables** tab →
New repository variable:

- Name: `GOOGLE_CLIENT_ID`
- Value: the Client ID from above.

The `Deploy PWA to GitHub Pages` workflow passes this as
`VITE_GOOGLE_CLIENT_ID` to the build, and the resulting bundle uses it
when initialising the OAuth flow.

### 3. (Optional) Local dev

```bash
cp apps/web/.env.example apps/web/.env.local
# put your Client ID into VITE_GOOGLE_CLIENT_ID
pnpm --filter @mtrack/web dev
```

## For each user (~2 minutes)

### 1. Anthropic API key

At [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
→ Create Key. Used in-browser for category suggestions and vision-based
PDF / receipt parsing. The key stays on the user's device.

### 2. Google Sheet

Either create a new sheet at [sheets.new](https://sheets.new) or use an
existing one. Copy the URL.

If sharing across users (e.g. spouse), share the sheet with their Google
account in the usual Drive way.

### 3. Open the PWA

`https://<deploy>.github.io/mtrack/` — paste the Anthropic key and the
sheet URL. **"Sign in to Google and verify"** opens the OAuth popup and
reads back the sheet title. If you see it, you're good.

After verification, tap **"Seed config tabs with defaults"** — creates
the config sheets with placeholder rules. Then go to **Rules** to
configure balances, route bank cards into balances, and map bank
categories, all without touching the sheet directly.

## What's in the sheet

| Tab | Purpose |
|---|---|
| `balances` | Your canonical accounts (flat): name, currency, type, archived. |
| `accounts` | Routes a bank card (`sourceChannel \| tail`) into a balance. Many cards → one balance; empty tail = channel default. |
| `categories` | Your categories: `name \| parent` (subcategories reference a parent). |
| `bank_category_map` | Bank-provided category → your category. |
| `merchant_rules` | Point rules by substring of description. |
| `counterparty_rules` | Rules for transfers and incomes (matched by description or bank category). |
| `operations` | All operations. Created automatically by import. |

Most of `balances`, `accounts` and `bank_category_map` can be filled from
the **Rules** tab in the app rather than by hand.

## Manual edit protection

Column `manualOverride` in `operations` is a comma-separated list of
fields you've pinned. The import will never overwrite those on the next
run.

Example: you change `category` from one value to another. Set
`manualOverride = category`. On the next import the category stays put
even if the rule layer would suggest something else.
