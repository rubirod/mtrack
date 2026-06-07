# @mtrack/web

PWA built with React + Vite + vite-plugin-pwa. Hosted on GitHub Pages
at `https://<owner>.github.io/mtrack/` via `.github/workflows/deploy-web.yml`.

See [docs/SETUP.md](../../docs/SETUP.md) for the first-launch flow.

## Local dev

```bash
pnpm --filter @mtrack/web dev
```

Opens `http://localhost:5173/mtrack/`. The service worker is disabled in
dev; PWA behaviour can be verified via `pnpm build && pnpm preview`.

## Deploy

Any push to `main` that touches `apps/web/**` triggers the GitHub
Actions workflow `.github/workflows/deploy-web.yml`. Pages must be
enabled in repo settings (Settings → Pages → Source: GitHub Actions).
