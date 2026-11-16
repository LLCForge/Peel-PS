// Tarayıcı derlemesinin Node'da sınanabilen parçaları: örnek kod (src/sample.js) tam hattan geçip açılmalı; worker'ın
// çalıştırdığı iş (engine.js) sonucu, günlüğü ve ara adımları döndürmeli; _headers kuralları ayrıştırılmalı ve worker
// CSP'si dış ağı, eval'ı ve wasm'ı kapatmalı; manifest ve service worker Peel-PS'e ait olmalı.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runPeel } from '../src/sandbox/engine.js';
import { SAMPLE } from '../src/sample.js';
import { parseHeaders } from '../vite.config.js';

// örnek: sıkıştırma + iex katmanı açılır, -f ile kurulan komut adı çözülür, indirme satırı kalır
const r = await runPeel({ input: SAMPLE, lang: 'en' });
assert.equal(r.ok, true);
const code = r.result.code;
assert.ok(code.includes("Write-Host 'Merhaba, Peel-PS!'"), `örnek açılmadı:\n${code}`);
assert.match(code, /iex \(New-Object Net\.WebClient\)\.DownloadString\(\$u\)/, 'indirme satırı korunmalı');
assert.doesNotMatch(code, /FromBase64String|ShellId|-f /i, `katman kaldı:\n${code}`);
assert.equal(r.result.report.threat.level, 'critical');
assert.ok(r.result.report.detection.some((d) => d.id === 'invoke-obfuscation'));
assert.ok(r.result.report.behaviour.network.some((n) => n.target === 'https://example.com/kurulum.ps1'));
assert.ok(r.passes.some(([id, state]) => id === 'layers' && state === 'ok'));
assert.ok(r.snapshots.length >= 2);

// barındırma başlıkları
const rules = parseHeaders(readFileSync(new URL('../public/_headers', import.meta.url), 'utf8'));
const worker = rules.find((x) => x.path === '/assets/web-worker-*')?.headers['Content-Security-Policy'] ?? '';
assert.match(worker, /default-src 'none'/);
assert.match(worker, /connect-src 'self'/);
assert.doesNotMatch(worker, /'unsafe-eval'|'unsafe-inline'|'wasm-unsafe-eval'/);
const page = rules.find((x) => x.path === '/index.html')?.headers['Content-Security-Policy'] ?? '';
assert.ok(page.includes("frame-ancestors 'none'"));
assert.doesNotMatch(page, /'unsafe-eval'|'wasm-unsafe-eval'/);

// PWA
const manifest = JSON.parse(readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
assert.match(manifest.name, /PowerShell/);
assert.deepEqual(manifest.icons.map((i) => i.src), ['peel-icon-512.png', 'peel-icon-1024.png', 'peel-icon.svg']);
assert.deepEqual(manifest.file_handlers[0].accept['text/plain'], ['.ps1', '.psm1', '.psd1']);
assert.match(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), /const VERSION = 'peel-ps-v\d+'/);
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
assert.match(html, /accept="\.ps1,\.psm1,\.psd1,\.txt/);
console.log(`web: örnek ${code.split('\n').length} satır, ${rules.length} başlık kuralı`);
