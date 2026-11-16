// Fixture testleri: test/fixtures/*.ps1.x tam hattan geçer. Fixture'lar diskte XOR + base64'tür (zararlı koda benzeyen
// örnekler antivirüsü tetiklemesin), yalnızca bellekte çözülür.
//   node test/run.js                  hepsi
//   node test/run.js enc-bxor         adında 'enc-bxor' geçenler, günlük ve çıktısıyla
//   node test/run.js --powershell     ayrıca # OUT: yönergesi olan fixture'ları gerçek Windows PowerShell'de (varsa)
//                                     çalıştırır: hem gizlenmiş girdi hem çözülmüş çıktı beklenen satırları üretmeli
// Yönergeler betikte yorum olarak yazılır ve denetimden önce çıktıdan ayıklanır:
//   # EXPECT: Write-Output 'x'   çıktıda bulunmalı (boşluklar normalize edilir)
//   # GONE: -join                çıktıda bulunmamalı
//   # KEEP: iex $c               çıktıda kalmalı (güvenlik: girdiye ve ağa bağlı kod silinmemeli; büyük/küçük harf duyarsız)
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deobfuscate } from '../src/core/pipeline.js';
import { decodeFixture } from './fixture-codec.js';

const dir = new URL('./fixtures/', import.meta.url);
const args = process.argv.slice(2);
const usePs = args.includes('--powershell');
const filter = args.find((a) => !a.startsWith('--'));
const files = readdirSync(dir).filter((f) => f.endsWith('.ps1.x') && (!filter || f.includes(filter))).sort();

const DIRECTIVE = /^[ \t]*#[ \t]*(EXPECT|GONE|KEEP|OUT):[ \t]*(.+)$/gm;
const directives = (src, key) => [...src.matchAll(DIRECTIVE)].filter((m) => m[1] === key).map((m) => m[2].trim());
const norm = (s) => s.replace(DIRECTIVE, '').replace(/\s+/g, ' ').trim();

// gerçek PowerShell yalnızca istenince ve varsa: betik geçici dosyaya yazılıp -File ile çalışır
const PS = usePs ? ['powershell.exe', 'pwsh'].find((exe) => spawnSync(exe, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).status === 0) : null;
if (usePs && !PS) console.log('PowerShell bulunamadı; --powershell denetimi atlandı');
const tmp = PS ? mkdtempSync(join(tmpdir(), 'peel-ps-run-')) : null;
function runPs(code) {
  const file = join(tmp, 'f.ps1');
  writeFileSync(file, `﻿${code}`);
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', timeout: 60_000 });
  return (r.stdout ?? '').replace(/\r/g, '').trim().split('\n').filter(Boolean);
}

let pass = 0;
let psChecked = 0;
const t0 = Date.now();
try {
  for (const f of files) {
    const src = decodeFixture(readFileSync(new URL(f, dir), 'utf8')).toString('utf8');
    const logs = [];
    const r = await deobfuscate(src, { onLog: (m, l) => logs.push(`[${l}] ${m}`) });
    const out = r.error ? '' : norm(r.code);
    const fails = [];
    if (r.error) fails.push(`hata: ${r.error}`);
    if (r.partial) fails.push('bütçe doldu');
    for (const e of directives(src, 'EXPECT')) if (!out.includes(norm(e))) fails.push(`EXPECT yok: ${e}`);
    for (const g of directives(src, 'GONE')) if (out.includes(norm(g))) fails.push(`GONE duruyor: ${g}`);
    // KEEP anlamsaldır: biçimlendirmenin büyük/küçük harf düzeltmesi sayılmaz
    for (const k of directives(src, 'KEEP')) if (!out.toLowerCase().includes(norm(k).toLowerCase())) fails.push(`KEEP silinmiş: ${k}`);
    const expected = directives(src, 'OUT');
    if (PS && expected.length && !r.error) {
      psChecked++;
      const a = runPs(src);
      const b = runPs(r.code);
      if (JSON.stringify(a) !== JSON.stringify(expected)) fails.push(`PowerShell (girdi): ${JSON.stringify(a)} ≠ ${JSON.stringify(expected)}`);
      if (JSON.stringify(b) !== JSON.stringify(expected)) fails.push(`PowerShell (çıktı): ${JSON.stringify(b)} ≠ ${JSON.stringify(expected)}`);
    }
    if (!fails.length) pass++;
    console.log(`${fails.length ? 'FAIL' : 'ok  '} ${f} (${r.ms ?? 0} ms)${fails.length ? `\n     ${fails.join('\n     ')}` : ''}`);
    if (filter || fails.length) {
      if (filter) console.log(logs.join('\n'));
      console.log(r.code ?? '');
    }
  }
} finally {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}
console.log(`\ntoplam ${Date.now() - t0}ms | ${pass}/${files.length}${PS ? ` | PowerShell ile doğrulanan: ${psChecked}` : ''}`);
if (pass !== files.length) process.exitCode = 1;
