# mtrack

Personal finance tracker. A PWA that imports bank statements, classifies
operations via configurable rules, and upserts them into a Google Sheets
spreadsheet that doubles as both storage and dashboard. No backend.

- **One language.** TypeScript everywhere.
- **One client.** PWA on React + Vite. Works on desktop and on iPhone via
  "Add to Home Screen".
- **One source of truth.** Google Sheets, accessed via user OAuth. The
  user owns their data and their access.
- **Two values to set up.** The Anthropic API key (paid by the user) and
  the spreadsheet URL. The OAuth Client ID is baked into the build — it's
  a public identifier locked to the deployed PWA's origin.

See [`docs/SETUP.md`](docs/SETUP.md) for setup, [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
for the design.

## Quick start

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.local
# fill VITE_GOOGLE_CLIENT_ID in apps/web/.env.local
pnpm --filter @mtrack/web dev
```

Open `http://localhost:5173/mtrack/`, paste your Anthropic key and the URL
of an empty Google Sheet. Tap "Seed config tabs with defaults" to populate
the config sheets, then go to "Import" and drop a CSV statement.

For production deploys to GitHub Pages, set `GOOGLE_CLIENT_ID` as a
repository variable (Settings → Secrets and variables → Actions →
Variables → New repository variable). The deploy workflow passes it to
the build as `VITE_GOOGLE_CLIENT_ID`.

## Layout

```
packages/core   isomorphic core: parsers, classifier, sheet-backed store
apps/web        PWA (React + Vite + vite-plugin-pwa)
```

A future backend would live under `apps/server/` and share the same `core`.

## License

MIT.
