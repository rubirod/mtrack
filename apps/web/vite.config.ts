import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves under /mtrack/ — without the correct base, assets 404.
const base = process.env.MTRACK_BASE ?? '/mtrack/';

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      // Keep sql.js out of precache — it's lazy-loaded only when the user
      // opens the Money Pro backup import, and weighs ~700KB on its own.
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        globIgnores: ['**/sql-wasm*'],
      },
      manifest: {
        name: 'mtrack',
        short_name: 'mtrack',
        description: 'Personal finance tracker: import, tap-confirm, cash entry, receipts',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: base,
        scope: base,
        icons: [
          { src: 'icon-192.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any maskable' },
          { src: 'icon-512.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
    }),
  ],
});
