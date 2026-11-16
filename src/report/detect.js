// PowerShell gizleyici tespiti. Invoke-Obfuscation ailesi bilinen işaretlerden oluşur; işaret ağırlıkları gürültülü-VEYA
// ile birleşir: güven = 1 - Π(1 - w). Yalnızca o araca özgü izler (ShellId/PSHome/ComSpec ile kurulan "iex",
// "{1}{0}" -f yeniden sıralama, ${;} özel karakter kodlaması) yüksek, başka yerde de görülebilen yapısal izler düşük
// ağırlıklıdır. Genel teknikler (base64, sıkıştırma, -EncodedCommand, karakter kodları, XOR ...) ayrıca "technique"
// olarak raporlanır. Kanıt yalnızca girdi ve açılan katmanlardan gelir; çözülmüş çıktıdaki kalıntılar sayılmaz.
import { pick, snippet, t, WHERE } from './text.js';

const MAX_SCAN = 4_000_000;
const clip = (s) => (s.length > MAX_SCAN ? s.slice(0, MAX_SCAN) : s);

// Invoke-Obfuscation izleri: [ad, regex | işlev, ağırlık, açıklama]
const IO_MARKS = [
  ['iex-build', /\$(?:shellid|pshome)\s*\[\s*\d+\s*\]\s*\+\s*\$(?:shellid|pshome)\s*\[\s*\d+\s*\]|\$env:comspec\s*\[\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\]|\.\s*name\s*\[\s*3\s*,\s*11\s*,\s*2\s*\]|\$verbosepreference\.tostring\(\)\s*\[\s*1\s*,\s*3\s*\]|\$env:public\s*\[\s*13\s*\]/i, 0.75,
    t('"iex" otomatik değişkenlerden kuruluyor ($ShellId[1]+$ShellId[13], $env:ComSpec[4,15,25], gv *mdr*)', '"iex" built from automatic variables ($ShellId[1]+$ShellId[13], $env:ComSpec[4,15,25], gv *mdr*)')],
  ['reorder', /["']\s*(?:\{\s*\d+\s*\}\s*){3,}["']\s*-f\s*['"]/i, 0.55, t('STRING/TOKEN: "{2}{0}{1}" -f yeniden sıralama', 'STRING/TOKEN: "{2}{0}{1}" -f reordering')],
  ['ticks', (s) => { const n = (s.match(/[\w-]`[a-zA-Z]/g) ?? []).length; return n >= 4 ? `\` ×${n}` : null; }, 0.35, t('TOKEN: adlarda ters tırnak (`)', 'TOKEN: backticks inside names')],
  ['case', (s) => {
    const words = s.match(/\b[A-Za-z]{5,}(?:-[A-Za-z]{3,})?\b/g) ?? [];
    const random = words.filter((w) => (w.match(/[a-z][A-Z]|[A-Z]{2}[a-z]/g) ?? []).length >= 2 && !/^[A-Z][a-z]+(?:[A-Z][a-z]+)*(?:-[A-Z][a-z]+(?:[A-Z][a-z]+)*)?$/.test(w));
    return random.length >= 4 && random.length > words.length * 0.2 ? `${random.slice(0, 3).join(' ')} ×${random.length}` : null;
  }, 0.3, t('TOKEN: rastgele büyük/küçük harf', 'TOKEN: random case')],
  ['reverse', /\[\s*-\s*1\s*\.\.\s*-\s*\(?\s*\$[\w{}:]+\.length|righttoleft/i, 0.45, t('STRING: ters çevrilmiş dizge ([-1..-n], RightToLeft)', 'STRING: reversed string ([-1..-n], RightToLeft)')],
  ['special', /\$\{[;=+@.[\]()&|"'#~*^%!<>?/\\:`,-]\}\s*=\s*\+\s*\$\(\s*\)/, 0.85, t('ENCODING: yalnızca özel karakterlerden kod (${;}=+$())', 'ENCODING: special-characters-only code (${;}=+$())')],
  ['charsplit', /-split\s*['"][^'"\n]{1,8}['"]\s*\|\s*(?:%|foreach(?:-object)?)\s*\{\s*\[char\]/i, 0.45, t('ENCODING: -split | % {[char]$_} karakter kodu çözücü', 'ENCODING: -split | % {[char]$_} char-code decoder')],
  ['compress', /new-object\s+(?:system\.)?io\.compression\.(?:deflate|gzip)stream\s*\(\s*\[(?:system\.)?io\.memorystream\]\s*\[(?:system\.)?convert\]::frombase64string/i, 0.45, t('COMPRESSION: DeflateStream([IO.MemoryStream][Convert]::FromBase64String(...))', 'COMPRESSION: DeflateStream([IO.MemoryStream][Convert]::FromBase64String(...))')],
];

const FAMILY = t('Invoke-Obfuscation', 'Invoke-Obfuscation');

function invokeObfuscation(sources, lang) {
  let miss = 1;
  const evidence = [];
  const done = new Set();
  for (const src of sources) {
    if (src.where === 'output') continue;
    const s = clip(src.text);
    const where = pick(WHERE[src.where], lang);
    for (const [id, test, w, desc] of IO_MARKS) {
      if (done.has(id)) continue;
      const hit = typeof test === 'function' ? test(s) : s.match(test)?.[0];
      if (!hit) continue;
      done.add(id);
      miss *= 1 - w;
      if (evidence.length < 6) evidence.push(`${pick(desc, lang)} (${where}): ${snippet(hit, 60)}`);
    }
  }
  const confidence = Math.round((1 - miss) * 100) / 100;
  // tek başına yapısal bir iz (yalnızca ` ya da büyük/küçük harf) aile için yetmez
  if (confidence < 0.5) return null;
  return { id: 'invoke-obfuscation', name: pick(FAMILY, lang), kind: 'obfuscator', confidence, evidence };
}

// Genel teknikler: [id, ad, regex, güven]
const TECHNIQUES = [
  ['encodedcommand', t('-EncodedCommand (UTF-16LE base64) başlatıcı', '-EncodedCommand (UTF-16LE base64) launcher'), /(?:powershell|pwsh)(?:\.exe)?["']?\s+(?:[-/]\w+(?:\s+(?!-)\S+)?\s+)*[-/]e(?:c|nc?|ncodedcommand|ncod\w*)?\s+[A-Za-z0-9+/]{16,}={0,2}/i, 0.8],
  ['launcher-flags', t('gizli başlatıcı bayrakları (-w hidden, -nop, -ep bypass)', 'stealthy launcher flags (-w hidden, -nop, -ep bypass)'), /[-/]w(?:i(?:n(?:d(?:o(?:w(?:s(?:t(?:y(?:le?)?)?)?)?)?)?)?)?)?\s+(?:hidden|1)\b|[-/](?:ep|ex\w*)\s+bypass\b/i, 0.55],
  ['cmd-launcher', t('cmd /c başlatıcı', 'cmd /c launcher'), /\bcmd(?:\.exe)?\s+(?:\/\w(?::\w+)?\s+)*\/[ckr]\b[^\n]{0,200}\b(?:powershell|pwsh)\b/i, 0.6],
  ['base64', t('base64 katmanı', 'base64 layer'), /\[(?:system\.)?convert\]::frombase64string/i, 0.65],
  ['compression', t('Deflate/GZip sıkıştırma katmanı', 'Deflate/GZip compression layer'), /io\.compression\.(?:deflate|gzip)stream/i, 0.75],
  ['securestring', t('SecureString (ConvertTo-SecureString -Key) katmanı', 'SecureString (ConvertTo-SecureString -Key) layer'), /76492d1116743f0423413b16050a5345|convertto-securestring[^\n|]{0,400}-k(?:ey)?\b/i, 0.75],
  ['char-codes', t('karakter kodu dizileri ([char] 72,101 ...)', 'character-code arrays ([char] 72,101 ...)'), /\[char\[\]\]\s*\(\s*\d{2,3}\s*(?:,\s*\d{2,3}\s*){3,}|(?:\[char\]\s*\(?\s*\d{2,3}\s*\)?\s*\+\s*){3,}/i, 0.6],
  ['radix', t('onaltılık/sekizlik/ikilik çözme ([Convert]::ToInt16($_, 16))', 'hex/octal/binary decoding ([Convert]::ToInt16($_, 16))'), /\[(?:system\.)?convert\]::to(?:int16|int32|byte)\s*\([^)]{0,40},\s*(?:16|8|2)\s*\)/i, 0.65],
  ['bxor', t('XOR (-bxor) çözücü', 'XOR (-bxor) decoder'), /-bxor\s*['"]?(?:0x[0-9a-f]+|\d+)/i, 0.6],
  ['format', t('-f biçim dizgesiyle parça birleştirme', '-f format-string assembly'), /["'](?:[^"'\n]{0,6}\{\d+\}){2,}[^"'\n]{0,6}["']\s*-f\s/i, 0.5],
  ['concat', t('dizge birleştirme (\'Wr\'+\'ite\')', 'string concatenation (\'Wr\'+\'ite\')'), /(?:['"][^'"\n]{1,12}['"]\s*\+\s*){3,}['"]/, 0.45],
  ['replace', t('.Replace / -replace yer tutucuları', '.Replace / -replace placeholders'), /\.replace\(\s*['"][^'"\n]{2,8}['"]\s*,\s*(?:\[string\])?\s*\[char\]|-c?replace\s*\(?\s*['"][^'"\n]{2,8}['"]\s*,\s*\[char\]/i, 0.6],
  ['iex-chain', t('Invoke-Expression katman zinciri', 'Invoke-Expression layer chain'), /(?:^|[\s;|(&.])(?:iex|invoke-expression)\b|\|\s*&?\s*\(?\s*\$(?:shellid|pshome|env:comspec)|\.invokescript\(|\[scriptblock\]::create\(/im, 0.55],
  ['indirection', t('değişken/komut dolaylılığı (Get-Variable, Set-Variable, ${..}, &(...))', 'variable/command indirection (Get-Variable, Set-Variable, ${..}, &(...))'), /\(\s*(?:get-variable|gv|get-item|gi|get-childitem|gci|ls|dir)\s+['"]?(?:variable:)?[\w*]+['"]?[^)]{0,30}\)\.value|\b(?:set-variable|sv)\s+['"]?\w+|&\s*\(\s*["'(]/i, 0.5],
];

function techniques(sources, layers, lang) {
  const found = new Map();
  const add = (id, name, conf, ev) => {
    const cur = found.get(id) ?? { id, name: pick(name, lang), kind: 'technique', confidence: 0, evidence: [] };
    cur.confidence = Math.max(cur.confidence, conf);
    if (cur.evidence.length < 4 && !cur.evidence.includes(ev)) cur.evidence.push(ev);
    found.set(id, cur);
  };
  if (layers.length) {
    const kinds = {};
    for (const l of layers) kinds[l.kind] = (kinds[l.kind] ?? 0) + 1;
    add('iex-chain', TECHNIQUES.find((x) => x[0] === 'iex-chain')[1], Math.min(0.95, 0.5 + 0.1 * layers.length), `${pick(WHERE.behaviour, lang)}: ${Object.entries(kinds).map(([k, n]) => `${k} ×${n}`).join(', ')}`);
    const flags = [...new Set(layers.flatMap((l) => l.flags ?? []))];
    if (flags.some((f) => /^-w (?:hidden|1)$|^-ep bypass$/.test(f))) add('launcher-flags', TECHNIQUES.find((x) => x[0] === 'launcher-flags')[1], 0.7, `${pick(WHERE.behaviour, lang)}: ${flags.join(' ')}`);
  }
  for (const src of sources) {
    if (src.where === 'output') continue;
    const s = clip(src.text);
    const where = pick(WHERE[src.where], lang);
    for (const [id, name, re, conf] of TECHNIQUES) {
      const m = s.match(re);
      if (m) add(id, name, conf, `${where}: ${snippet(m[0], 50)}`);
    }
    const ticks = (s.match(/[\w-]`[a-zA-Z]/g) ?? []).length;
    if (ticks >= 3) add('ticks', t('ters tırnak (`) kaçışları', 'backtick (`) escapes'), Math.min(0.85, 0.5 + ticks / 100), `${where}: \` ×${ticks}`);
  }
  return [...found.values()];
}

/**
 * @param {Array<{where, text}>} sources text.js sourcesOf çıktısı
 * @param {Array} layers açılan katmanlar (trace.layers)
 */
export function detect(sources, layers = [], lang = 'tr') {
  const out = [invokeObfuscation(sources, lang)].filter(Boolean);
  out.push(...techniques(sources, layers, lang));
  for (const d of out) d.confidence = Math.round(d.confidence * 100) / 100;
  const rank = { obfuscator: 0, technique: 1 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || b.confidence - a.confidence);
}
