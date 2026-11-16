// Ölçüm: node test/bench.js [filtre] [--powershell]
// Örnekler her çalıştırmada bellekte üretilir (diske yazılmaz): üç zararsız yük, Invoke-Obfuscation ailelerini (TOKEN,
// STRING, ENCODING, COMPRESSION, LAUNCHER) izleyen 16 tekniğin her biriyle tek katman ve sabit tohumlu rastgele 2-4
// katmanlı zincirler. Ölçütler:
//   açıldı (unwrapped): çıktıda gizleme kalıbı kalmadı ve yükün komutları okunur hâlde geri geldi
//   aynı davranış:      --powershell ile, yerel Windows PowerShell'de gizlenmiş örnek ve çözülmüş çıktı aynı satırları yazdı
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { createCipheriv } from 'node:crypto';
import { deobfuscate } from '../src/core/pipeline.js';

const args = process.argv.slice(2);
const filter = args.find((a) => !a.startsWith('--'));
const usePs = args.includes('--powershell');

// belirlenimci rastgelelik (mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PAYLOADS = {
  hello: { code: "Write-Output 'hello world'", expect: ['Write-Output'] },
  multi: { code: "$name = 'peel'\nWrite-Output \"merhaba $name\"\nforeach ($i in 1..3) { Write-Output \"sayi $i\" }\n'bitti' | Write-Output", expect: ['Write-Output', 'foreach'] },
  calc: { code: "[int]$n = 21\nWrite-Output ($n * 2)\nWrite-Output ('{0}-{1}' -f 'a', 'b')", expect: ['Write-Output', '$n * 2'] },
};
// çıktıda kalmaması gereken gizleme kalıpları (yüklerin kendisinde bulunmayanlar)
const LEFTOVER = /FromBase64String|DeflateStream|GZipStream|-bxor|ToInt16|SecureString|\$ShellId|\$PSHome|ComSpec|RightToLeft|\[char\]|-join|-split|\$\(@\{\}\)|\biex\b|Invoke-Expression|InvokeScript|::Create|-enc\b|\.Replace\(/i;

const sq = (s) => `'${s.replace(/'/g, "''")}'`;
const b64u = (s) => Buffer.from(s, 'utf16le').toString('base64');
const IEX = ['I', 'EX'].join('');

function makeTechniques(r) {
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const mixCase = (s) => [...s].map((c) => (r() < 0.5 ? c.toUpperCase() : c.toLowerCase())).join('');
  // "iex" kurulumları ve çağırma biçimleri
  const iexName = () => pick([IEX, `(${'$ShellId'}[1]+$ShellId[13]+'x')`, "($PSHome[4]+$PSHome[30]+'x')", "($env:ComSpec[4,15,25]-join'')", "((gv '*mdr*').Name[3,11,2]-join'')", "($VerbosePreference.ToString()[1,3]+'x'-join'')"]);
  const run = (expr) => {
    const name = iexName();
    return pick([
      () => (name === IEX ? `${mixCase(IEX)} (${expr})` : `&${name} (${expr})`),
      () => `(${expr}) | ${name === IEX ? mixCase(IEX) : `&${name}`}`,
      () => `$ExecutionContext.InvokeCommand.InvokeScript((${expr}))`,
      () => `. ([ScriptBlock]::Create((${expr})))`,
    ])();
  };
  const chunks = (s) => {
    const out = [];
    for (let i = 0; i < s.length;) { const n = 1 + Math.floor(r() * 6); out.push(s.slice(i, i + n)); i += n; }
    return out;
  };
  return {
    concat: (s) => run(chunks(s).map(sq).join('+')),
    reorder: (s) => {
      const parts = chunks(s);
      const order = parts.map((_, i) => i).sort(() => r() - 0.5);
      // biçim dizgesinde yalnızca yer tutucular; parçalar tek tırnaklı argüman
      const fmt = parts.map((_, i) => `{${order.indexOf(i)}}`).join('');
      return run(`"${fmt}" -f ${order.map((i) => sq(parts[i])).join(',')}`);
    },
    reverse: (s) => `$r = ${sq([...s].reverse().join(''))}; ${run('$r[-1..-($r.Length)] -join \'\'')}`,
    'reverse-regex': (s) => run(`-join [regex]::Matches(${sq([...s].reverse().join(''))}, '.', 'RightToLeft, Singleline')`),
    replace: (s) => {
      // her uygulamada ayrı yer tutucu: iç içe Replace katmanları birbirinin yer tutucusunu bozmasın
      const k = Math.floor(r() * 1e6).toString(36);
      return run(`${sq(s.replace(/'/g, `~Q${k}~`).replace(/ /g, `~S${k}~`))}.Replace('~Q${k}~',[string][char]39).Replace('~S${k}~',' ')`);
    },
    ascii: (s) => run(`-join (${sq([...s].map((c) => c.charCodeAt(0)).join(','))} -split ',' | ForEach-Object { [char][int]$_ })`),
    hex: (s) => run(`-join (${sq([...s].map((c) => c.charCodeAt(0).toString(16)).join('x'))} -split 'x' | % { [char]([Convert]::ToInt16($_, 16)) })`),
    octal: (s) => run(`-join (${sq([...s].map((c) => c.charCodeAt(0).toString(8)).join(':'))}.Split(':') | % { [char]([Convert]::ToInt16($_, 8)) })`),
    binary: (s) => run(`-join (${sq([...s].map((c) => c.charCodeAt(0).toString(2)).join('~'))}.Split('~') | % { [char]([Convert]::ToInt16($_, 2)) })`),
    bxor: (s) => { const k = 1 + Math.floor(r() * 250); return run(`-join (${sq([...Buffer.from(s, 'utf8')].map((b) => (b ^ k).toString(16)).join(','))}.Split(',') | % { [char]([Convert]::ToInt16($_, 16) -bxor ${k}) })`); },
    base64: (s) => run(`[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${b64u(s)}'))`),
    deflate: (s) => run(`(New-Object IO.StreamReader((New-Object IO.Compression.DeflateStream([IO.MemoryStream][Convert]::FromBase64String('${deflateRawSync(Buffer.from(s)).toString('base64')}'),[IO.Compression.CompressionMode]::Decompress)),[Text.Encoding]::UTF8)).ReadToEnd()`),
    gzip: (s) => `$m = New-Object IO.MemoryStream(,[Convert]::FromBase64String('${gzipSync(Buffer.from(s)).toString('base64')}'))\n$g = New-Object IO.Compression.GZipStream($m, [IO.Compression.CompressionMode]::Decompress)\n${run('(New-Object IO.StreamReader($g)).ReadToEnd()')}`,
    securestring: (s) => {
      const key = Array.from({ length: 16 }, () => Math.floor(r() * 256));
      const iv = Buffer.from(Array.from({ length: 16 }, () => Math.floor(r() * 256)));
      const c = createCipheriv('aes-128-cbc', Buffer.from(key), iv);
      const enc = Buffer.concat([c.update(Buffer.from(s, 'utf16le')), c.final()]);
      const blob = `76492d1116743f0423413b16050a5345${Buffer.from(`2|${iv.toString('base64')}|${enc.toString('hex')}`, 'utf16le').toString('base64')}`;
      return run(`[Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR(('${blob}' | ConvertTo-SecureString -Key (${key.join(',')}))))`);
    },
    ticks: (s) => {
      // TOKEN: dış katmanın komut adlarında ` ve rastgele harf (kaçış harflerinden önce ` konmaz)
      // önce rastgele harf, sonra `: `a `b `e `f `n `r `t `u `v kaçıştır, bu küçük harflerden önce ` konmaz
      const tick = (w) => [...w].map((c, i) => (i && /[cdg-mo-qswxyzA-Z]/.test(c) && r() < 0.4 ? `\`${c}` : c)).join('');
      return `${tick(mixCase('Invoke-Expression'))} (${chunks(s).map(sq).join('+')})`;
    },
    launcher: (s) => `powershell.exe ${mixCase('-NoP')} ${mixCase('-NonI')} -W Hidden ${mixCase('-Exec')} Bypass -Enc ${b64u(s)}`,
  };
}

const TECH = Object.keys(makeTechniques(rng(1)));
const samples = [];
for (const [p, payload] of Object.entries(PAYLOADS)) {
  for (const t of TECH) samples.push({ name: `${t} · ${p}`, payload, chain: [t], seed: samples.length + 1 });
  const r = rng(1000 + samples.length);
  for (let k = 0; k < 8; k++) {
    const depth = 2 + Math.floor(r() * 3);
    // başlatıcı yalnızca en dış katman olabilir
    const inner = TECH.filter((t) => t !== 'launcher');
    const chain = Array.from({ length: depth }, () => inner[Math.floor(r() * inner.length)]);
    if (r() < 0.3) chain[chain.length - 1] = 'launcher';
    samples.push({ name: `random ${chain.join('>')} · ${p}`, payload, chain, seed: samples.length + 1 });
  }
}

const PS = usePs ? ['powershell.exe', 'pwsh'].find((exe) => spawnSync(exe, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).status === 0) : null;
if (usePs && !PS) console.log('PowerShell bulunamadı; davranış karşılaştırması atlandı');
const tmp = PS ? mkdtempSync(join(tmpdir(), 'peel-ps-bench-')) : null;
const runPs = (code) => {
  const file = join(tmp, 'b.ps1');
  writeFileSync(file, `﻿${code}`);
  const res = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', timeout: 60_000 });
  return `${res.stdout ?? ''}`.replace(/\r/g, '').trim();
};

const norm = (s) => s.replace(/\s+/g, ' ').toLowerCase();
let total = 0;
let unwrapped = 0;
let same = 0;
let compared = 0;
let slowest = 0;
let sumMs = 0;
const byTech = new Map();
try {
  for (const s of samples.filter((x) => !filter || x.name.includes(filter))) {
    const tech = makeTechniques(rng(s.seed));
    let src = s.payload.code;
    // Windows komut satırı 32767 karakterle sınırlı: -Enc yükü bunu aşacaksa başlatıcı yerine base64 katmanı
    for (const t of s.chain) src = tech[t === 'launcher' && src.length * 2.7 > 30_000 ? 'base64' : t](src);
    total++;
    const t0 = Date.now();
    const res = await deobfuscate(src);
    const ms = Date.now() - t0;
    sumMs += ms;
    slowest = Math.max(slowest, ms);
    const out = res.code ?? '';
    const ok = !res.error && !res.partial && !LEFTOVER.test(out) && s.payload.expect.every((e) => norm(out).includes(norm(e)));
    if (ok) unwrapped++;
    let eq = null;
    if (PS) {
      compared++;
      const a = runPs(src);
      const b = runPs(out);
      eq = a === b && a.length > 0;
      if (eq) same++;
    }
    const key = s.chain.length === 1 ? s.chain[0] : 'random';
    const row = byTech.get(key) ?? { n: 0, ok: 0, same: 0 };
    row.n++;
    row.ok += ok ? 1 : 0;
    row.same += eq ? 1 : 0;
    byTech.set(key, row);
    console.log(`${ok ? 'ok  ' : 'FAIL'}${eq === null ? '' : eq ? ' same' : ' DIFF'} ${s.name} (${src.length} → ${out.length} B, ${ms} ms)`);
    if (filter) console.log(`${src}\n----\n${res.error ?? out}`);
  }
} finally {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}
console.log('\nteknik            açıldı   aynı davranış');
for (const [k, v] of byTech) console.log(`${k.padEnd(18)}${`${v.ok}/${v.n}`.padEnd(9)}${PS ? `${v.same}/${v.n}` : '-'}`);
console.log(`\naçıldı: ${unwrapped}/${total}${PS ? ` | aynı davranış: ${same}/${compared}` : ''} | ortalama ${Math.round(sumMs / Math.max(1, total))} ms, en yavaş ${slowest} ms`);
