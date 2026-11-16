import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

// Barındırma başlıkları tek kaynaktan gelir: public/_headers (Netlify / Cloudflare Pages biçimi; derlemede dist/'e kopyalanır).
// `vite preview` aynı kuralları uygular; `vite dev` sayfa CSP'si vermez (satır içi betik ve HMR soketi), ama çözücü
// worker'ı dev'de de kendi CSP'siyle çalışır.
//   Sayfa CSP'si: yalnızca aynı köken (WebAssembly ve eval yok).
//   Worker CSP'si: default-src 'none'; script-src 'self'; connect-src 'self' (yalnızca kendi parçaları). Dış ağ, eval,
//   wasm ve iç içe worker tarayıcıda engellenir; JS kilidi (src/sandbox/web-worker.js) ikinci katmandır.
const WORKER_RULE = '/assets/web-worker-*';

export function parseHeaders(text) {
  const rules = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) { rules.push({ path: line.trim(), headers: {} }); continue; }
    const i = line.indexOf(':');
    if (i > 0 && rules.length) rules.at(-1).headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return rules;
}
const toRegex = (p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

function headers() {
  const rules = parseHeaders(readFileSync(new URL('./public/_headers', import.meta.url), 'utf8'))
    .map((r) => ({ ...r, re: toRegex(r.path) }));
  const worker = rules.find((r) => r.path === WORKER_RULE)?.headers ?? {};
  const serve = (prod) => (req, res, next) => {
    const { pathname } = new URL(req.url ?? '/', 'http://local');
    for (const r of rules) {
      if (!r.re.test(pathname)) continue;
      // dev'de yalnızca ortak başlıklar (sayfa CSP'si Vite'ın satır içi betiklerini kırar)
      if (!prod && r.headers['Content-Security-Policy']) continue;
      for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
    }
    // dev worker yolu: /src/sandbox/web-worker.js?worker_file&type=module
    if (!prod && pathname.endsWith('/src/sandbox/web-worker.js')) for (const [k, v] of Object.entries(worker)) res.setHeader(k, v);
    next();
  };
  return {
    name: 'peel-headers',
    configureServer(server) { server.middlewares.use(serve(false)); },
    configurePreviewServer(server) { server.middlewares.use(serve(true)); },
  };
}

export default defineConfig({
  plugins: [headers()],
  // worker çok parçalı ES modülüdür
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 2048 },
  // node_modules bir bağlantı (junction/symlink) olabilir: gerçek yolu da dev sunucusunun izin listesine girer
  server: { fs: { allow: [ROOT, realpathSync(new URL('./node_modules', import.meta.url))] } },
});
