import { execSync } from 'node:child_process';
import { type Plugin, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// COOP/COEP make the page cross-origin isolated (SharedArrayBuffer, precise timers).
// Production sets the same headers via public/_headers on Cloudflare Pages.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// Build label shown in Diagnostics, so it's obvious which version a device is running.
function buildLabel(): string {
  const env = process.env.WORKERS_CI_COMMIT_SHA ?? process.env.CF_PAGES_COMMIT_SHA;
  let sha = env?.slice(0, 7) ?? '';
  if (!sha) {
    try {
      sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      sha = 'dev';
    }
  }
  return `${sha} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// Transformers.js references ONNX Runtime's WebGPU/asyncify WASM (25.6 MB), so Vite emits it — over Cloudflare's
// 25 MiB per-file limit, which fails the deploy. We never load it: the Whisper worker points ORT at the self-hosted
// plain build in /ort/ (scripts/copy-runtimes.mjs). Drop it from the bundle.
const dropUnusedOrtWasm: Plugin = {
  name: 'pawcut-drop-unused-ort-wasm',
  generateBundle(_options, bundle) {
    for (const name of Object.keys(bundle)) {
      if (/ort-wasm-simd-threaded\.(asyncify|jsep|jspi)[^/]*\.wasm$/.test(name)) delete bundle[name];
    }
  },
};

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(buildLabel()) },
  plugins: [
    dropUnusedOrtWasm,
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icons/*.png', 'icons/icon.svg'],
      manifest: {
        name: 'PawCut',
        short_name: 'PawCut',
        description: 'Fast vertical video editor for short-form content',
        theme_color: '#0b0b0f',
        background_color: '#0b0b0f',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        globIgnores: ['mediapipe/**', 'models/**', 'ort/**'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        // AI runtimes/models are big: cached on first use instead of at install.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/mediapipe/') || url.pathname.startsWith('/models/') || url.pathname.startsWith('/ort/'),
            handler: 'CacheFirst',
            options: { cacheName: 'ai-models', expiration: { maxEntries: 20 } },
          },
        ],
      },
    }),
  ],
  worker: { format: 'es' },
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  build: { target: 'es2022' },
});
