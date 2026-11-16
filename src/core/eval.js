// Güvenli statik değerlendirici: PowerShell'in yan etkisiz bir alt kümesini (dizgeler, sayılar, diziler, dönüştürmeler,
// -f/-join/-split/-replace/-bxor, [Convert]/[Text.Encoding]/[char] yöntemleri, raw deflate/gzip, SecureString -Key ...)
// JavaScript'te hesaplar. Betik hiçbir zaman çalıştırılmaz: bilinmeyen komut, yöntem ya da değişken Nope fırlatır ve
// çağıran o ifadeyi olduğu gibi bırakır. Her düğüm bütçeden bir adım harcar (zaman ve adım sınırı).
import { Nope, BudgetError, nope, PSChar, Obj, isObj, toStr, toNum, toInt, toBool, enumerate, collapse, checkString, toBytes, MAX_ARRAY, MAX_STRING } from './values.js';
import { base64Decode, base64Encode, encodingName, decodeText, encodeText, inflateRaw, gunzip, CodecError } from './codec.js';
import { decryptSecureString } from './crypto.js';
import { DEFAULT_VARIABLES, COMMANDS, ALIASES } from './known.js';

const ActionPreference = (name, value) => new Obj('enum', { type: 'ActionPreference', name, value });

/** Windows PowerShell 5.1'in değişmeyen otomatik değişkenleri (betik bunlara atama yapmıyorsa geçerli) */
export const AUTOMATIC = {
  shellid: 'Microsoft.PowerShell',
  pshome: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
  verbosepreference: ActionPreference('SilentlyContinue', 0),
  debugpreference: ActionPreference('SilentlyContinue', 0),
  informationpreference: ActionPreference('SilentlyContinue', 0),
  erroractionpreference: ActionPreference('Continue', 2),
  warningpreference: ActionPreference('Continue', 2),
  progresspreference: ActionPreference('Continue', 2),
  confirmpreference: new Obj('enum', { type: 'ConfirmImpact', name: 'High', value: 3 }),
  maximumdrivecount: 4096,
  maximumaliascount: 4096,
  maximumfunctioncount: 4096,
  maximumvariablecount: 4096,
  maximumerrorcount: 256,
  maximumhistorycount: 4096,
  formatenumerationlimit: 4,
  nestedpromptlevel: 0,
  'env:comspec': 'C:\\WINDOWS\\system32\\cmd.exe',
  'env:public': 'C:\\Users\\Public',
  'env:windir': 'C:\\WINDOWS',
  'env:systemroot': 'C:\\WINDOWS',
};

// ── tür adları ──
const ACCEL = {
  int: 'int32', long: 'int64', short: 'int16', float: 'single', bool: 'boolean', regex: 'text.regularexpressions.regex',
  scriptblock: 'management.automation.scriptblock', pscredential: 'management.automation.pscredential', securestring: 'security.securestring',
  psobject: 'management.automation.psobject', pscustomobject: 'management.automation.pscustomobject', wmiclass: 'management.managementclass',
  'text.utf8encoding': 'text.utf8encoding', marshal: 'runtime.interopservices.marshal', hashtable: 'collections.hashtable',
  version: 'version', uri: 'uri', 'io.compression.compressionmode': 'io.compression.compressionmode', ipaddress: 'net.ipaddress',
};
/** [System.Text.Encoding] → 'text.encoding'; hızlandırıcılar tam adlarına */
export function typeKey(name) {
  let n = String(name).toLowerCase().replace(/\s+/g, '');
  if (n.startsWith('system.')) n = n.slice(7);
  const arr = n.endsWith('[]') ? '[]' : '';
  const base = arr ? n.slice(0, -2) : n;
  return (ACCEL[base] ?? base) + arr;
}
const FULL = {
  string: 'System.String', char: 'System.Char', int32: 'System.Int32', int64: 'System.Int64', byte: 'System.Byte', convert: 'System.Convert',
  'text.encoding': 'System.Text.Encoding', 'net.webclient': 'System.Net.WebClient', 'io.memorystream': 'System.IO.MemoryStream',
  'io.streamreader': 'System.IO.StreamReader', 'io.compression.deflatestream': 'System.IO.Compression.DeflateStream',
  'io.compression.gzipstream': 'System.IO.Compression.GZipStream', 'management.automation.scriptblock': 'System.Management.Automation.ScriptBlock',
};
const fullName = (display) => FULL[typeKey(display)] ?? (/^system\./i.test(display) ? display : `System.${display}`);
export const typeObj = (display) => new Obj('type', { display, key: typeKey(display), full: fullName(display) });

// ── PowerShell karşılaştırma ve düzenli ifadeler ──
const strEq = (a, b, cs) => (cs ? a === b : a.toLowerCase() === b.toLowerCase());
function compare(a, b, cs) {
  if (typeof a === 'string') {
    const sb = toStr(b);
    const [x, y] = cs ? [a, sb] : [a.toLowerCase(), sb.toLowerCase()];
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = toNum(a);
  const y = toNum(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
const equals = (a, b, cs) => {
  if (a === null || b === null) return a === b;
  if (typeof a === 'string') return strEq(a, toStr(b), cs);
  if (typeof a === 'boolean') return a === toBool(b);
  try { return toNum(a) === toNum(b); } catch (e) { if (e instanceof Nope) return false; throw e; }
};

/** .NET düzenli ifadesi → RegExp; JavaScript'te farklı anlamlı yapılar Nope */
export function netRegex(pattern, flags) {
  const p = String(pattern);
  if (/\\[AZzGK]|\(\?#|\(\?[imnsx-]+[:)]|\(\?<[=!]|\\p\{Is|\(\?>|\[[^\]]*-\[|\$\{|\\k</.test(p) || p.length > 4096) nope('düzenli ifade desteklenmiyor');
  // iç içe niceleyici ((a+)+, (a|aa)*): felaket geri izleme riski; değerlendirilmez
  if (/\((?:[^()\\]|\\.)*[+*?|{](?:[^()\\]|\\.)*\)[+*{]/.test(p)) nope('düzenli ifade felaket geri izleme riski taşıyor');
  try {
    return new RegExp(p, flags);
  } catch {
    return nope('düzenli ifade derlenemedi');
  }
}
/** .NET yerine koyma dizgesi: $0 → $& ; ${ad} → $<ad> */
const netReplacement = (r) => String(r).replace(/\$(\$|\d+|\{(\w+)\}|&|`|'|_|\+)/g, (m, x, name) => {
  if (x === '$') return '$$';
  if (x === '0') return '$&';
  if (name) return /^\d+$/.test(name) ? `$${name}` : `$<${name}>`;
  if (/^\d+$/.test(x) || x === '&') return m;
  return nope('yerine koyma deseni');
});
const wildcard = (pattern) => new RegExp(`^${String(pattern).replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'is');

/** .NET bileşik biçimi: {0}, {0,5}, {0:X2}, {{ }} */
export function netFormat(fmt, args) {
  let out = '';
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c === '{') {
      if (fmt[i + 1] === '{') { out += '{'; i++; continue; }
      const m = /^\{\s*(\d+)\s*(?:,\s*(-?\d+)\s*)?(?::([^}]*))?\}/.exec(fmt.slice(i));
      if (!m) nope('biçim dizgesi bozuk');
      const idx = Number(m[1]);
      if (idx >= args.length) nope('biçim indeksi aralık dışı');
      let s = formatValue(args[idx], m[3] ?? '');
      const w = m[2] ? Number(m[2]) : 0;
      if (Math.abs(w) > s.length) s = w > 0 ? s.padStart(w) : s.padEnd(-w);
      out += s;
      i += m[0].length - 1;
      continue;
    }
    if (c === '}') {
      if (fmt[i + 1] === '}') { out += '}'; i++; continue; }
      nope('biçim dizgesi bozuk');
    }
    out += c;
  }
  return checkString(out);
}
function formatValue(v, spec) {
  if (!spec || typeof v === 'string' || v instanceof PSChar || v === null) return toStr(v);
  const m = /^([XxDd])(\d{0,3})$/.exec(spec);
  if (!m || typeof v !== 'number' || !Number.isInteger(v)) return nope('biçim belirteci desteklenmiyor');
  const n = m[1] === 'X' || m[1] === 'x' ? (v < 0 ? (v >>> 0) : v).toString(16) : String(Math.abs(v));
  const s = (m[1] === 'X' ? n.toUpperCase() : n).padStart(Number(m[2] || 0), '0');
  return (m[1] === 'D' || m[1] === 'd') && v < 0 ? `-${s}` : s;
}

// ── nesneler ──
const enc = (name) => {
  const e = encodingName(name);
  return e ? new Obj('encoding', { enc: e }) : nope('kodlama');
};
function streamBytes(v) {
  if (isObj(v, 'memorystream')) return v.bytes;
  if (isObj(v, 'compress')) {
    if (!v.decompress) nope('sıkıştırma akışı');
    if (!v.out) {
      const src = streamBytes(v.inner);
      try {
        v.out = v.gzip ? gunzip(src) : inflateRaw(src);
      } catch (e) {
        if (e instanceof CodecError) nope(e.message);
        throw e;
      }
    }
    return v.out;
  }
  return nope('akış değil');
}
function construct(key, args) {
  switch (key) {
    case 'io.memorystream': {
      if (!args.length) return new Obj('memorystream', { bytes: new Uint8Array(0) });
      const b = toBytes(args[0]);
      if (args.length === 3) return new Obj('memorystream', { bytes: b.slice(toInt(args[1]), toInt(args[1]) + toInt(args[2])) });
      return new Obj('memorystream', { bytes: b });
    }
    case 'io.compression.deflatestream':
    case 'io.compression.gzipstream': {
      const mode = args[1];
      const name = isObj(mode, 'enum') ? mode.name : toStr(mode);
      if (!/^decompress$/i.test(name)) nope('sıkıştırma kipi');
      if (!isObj(args[0], 'memorystream') && !isObj(args[0], 'compress')) nope('akış değil');
      return new Obj('compress', { inner: args[0], gzip: key.endsWith('gzipstream'), decompress: true });
    }
    case 'io.streamreader': {
      if (!isObj(args[0], 'memorystream') && !isObj(args[0], 'compress')) nope('akış değil');
      const e = args[1] === undefined ? 'UTF8' : isObj(args[1], 'encoding') ? args[1].enc : nope('kodlama');
      return new Obj('reader', { source: args[0], enc: e });
    }
    case 'string': {
      const a = args.length === 1 ? args[0] : nope('string kurucu');
      if (Array.isArray(a)) return checkString(a.map((x) => (x instanceof PSChar ? String.fromCharCode(x.code) : toStr(x))).join(''));
      return toStr(a);
    }
    case 'text.utf8encoding': return new Obj('encoding', { enc: 'UTF8' });
    case 'text.asciiencoding': return new Obj('encoding', { enc: 'ASCII' });
    case 'text.unicodeencoding': return new Obj('encoding', { enc: 'Unicode' });
    case 'management.automation.pscredential': {
      if (args.length !== 2 || !isObj(args[1], 'securestring')) nope('PSCredential');
      return new Obj('credential', { user: toStr(args[0]), password: args[1] });
    }
    default:
      return nope(`tür kurulamaz: ${key}`);
  }
}

/** [tip]değer dönüştürmesi */
function cast(key, v) {
  switch (key) {
    case 'string': return toStr(v);
    case 'char': {
      if (v instanceof PSChar) return v;
      if (typeof v === 'string') return v.length === 1 ? new PSChar(v.charCodeAt(0)) : nope('[char] tek karakter ister');
      return new PSChar(toInt(v, 0, 65535));
    }
    case 'int32': return v instanceof PSChar ? v.code : toInt(v);
    case 'int16': return v instanceof PSChar ? v.code : toInt(v, -32768, 32767);
    case 'int64': return v instanceof PSChar ? v.code : toInt(v, -(2 ** 53), 2 ** 53);
    case 'byte': return toInt(v instanceof PSChar ? v.code : v, 0, 255);
    case 'sbyte': return toInt(v, -128, 127);
    case 'uint16': return v instanceof PSChar ? v.code : toInt(v, 0, 65535);
    case 'uint32': return toInt(v, 0, 4294967295);
    case 'double': case 'single': case 'decimal': return toNum(v);
    case 'boolean': return toBool(v);
    case 'char[]': {
      if (typeof v === 'string') return Array.from(v, (c) => new PSChar(c.charCodeAt(0))).slice(0, MAX_ARRAY);
      return enumerate(v).map((x) => cast('char', x));
    }
    case 'byte[]': return v instanceof Uint8Array ? v : toBytes(enumerate(v).map((x) => cast('byte', x)));
    case 'int32[]': case 'int[]': case 'int16[]': case 'int64[]': return enumerate(v).map((x) => cast(key.slice(0, -2), x));
    case 'string[]': return enumerate(v).map(toStr);
    case 'object[]': case 'array': return Array.isArray(v) ? v : enumerate(v);
    case 'object': case 'management.automation.psobject': return v;
    case 'type': return isObj(v, 'type') ? v : typeObj(toStr(v));
    case 'management.automation.scriptblock': return isObj(v, 'scriptblock') ? v : nope('scriptblock dönüştürme');
    case 'io.memorystream': return construct('io.memorystream', [v]);
    case 'text.encoding': return isObj(v, 'encoding') ? v : nope('kodlama');
    case 'text.regularexpressions.regex': return new Obj('regex', { pattern: toStr(v) });
    default: return nope(`dönüştürme desteklenmiyor: ${key}`);
  }
}

// ── yöntemler ──
const sval = (v) => (v instanceof PSChar ? String.fromCharCode(v.code) : toStr(v));
const charsOf = (v) => (Array.isArray(v) ? v.map(sval).join('') : sval(v));

function stringMethod(s, name, args) {
  const a = args;
  switch (name) {
    case 'replace': {
      if (a.length !== 2) nope('Replace');
      const from = sval(a[0]);
      if (!from) nope('Replace boş');
      return checkString(s.split(from).join(sval(a[1])));
    }
    case 'split': {
      if (!a.length) return s.split(/[\s]/);
      if (a.length > 1 && typeof a[a.length - 1] === 'number') nope('Split sayaç');
      const seps = a.length === 1 && Array.isArray(a[0]) ? charsOf(a[0]) : a.map(sval).join('');
      // .NET Framework: Split(string) yoktur, dizge karakter dizisi olur; PowerShell 7'de dizge ayırıcıdır: tek karakterde aynı
      if (a.length === 1 && !Array.isArray(a[0]) && sval(a[0]).length > 1) nope('Split çok karakterli');
      if (!seps) return [s];
      const set = new Set(seps);
      const out = [];
      let cur = '';
      for (const ch of s) { if (set.has(ch)) { out.push(cur); cur = ''; } else cur += ch; }
      out.push(cur);
      return out;
    }
    case 'tochararray': return Array.from(s, (c) => new PSChar(c.charCodeAt(0)));
    case 'substring': {
      const i = toInt(a[0]);
      const len = a.length > 1 ? toInt(a[1]) : s.length - i;
      if (i < 0 || len < 0 || i + len > s.length) nope('Substring aralık');
      return s.substr(i, len);
    }
    case 'toupper': case 'toupperinvariant': return s.toUpperCase();
    case 'tolower': case 'tolowerinvariant': return s.toLowerCase();
    case 'trim': case 'trimstart': case 'trimend': {
      const chars = a.length ? charsOf(a.length === 1 ? a[0] : a) : null;
      const isT = chars ? (c) => chars.includes(c) : (c) => /\s/.test(c);
      let x = 0;
      let y = s.length;
      if (name !== 'trimend') while (x < y && isT(s[x])) x++;
      if (name !== 'trimstart') while (y > x && isT(s[y - 1])) y--;
      return s.slice(x, y);
    }
    case 'insert': {
      const i = toInt(a[0]);
      if (i < 0 || i > s.length) nope('Insert aralık');
      return checkString(s.slice(0, i) + sval(a[1]) + s.slice(i));
    }
    case 'remove': {
      const i = toInt(a[0]);
      const n = a.length > 1 ? toInt(a[1]) : s.length - i;
      if (i < 0 || n < 0 || i + n > s.length) nope('Remove aralık');
      return s.slice(0, i) + s.slice(i + n);
    }
    case 'padleft': case 'padright': {
      const w = toInt(a[0]);
      if (w > MAX_STRING) nope('Pad');
      const ch = a.length > 1 ? sval(a[1]) : ' ';
      return name === 'padleft' ? s.padStart(w, ch) : s.padEnd(w, ch);
    }
    case 'contains': return s.includes(sval(a[0]));
    case 'startswith': return s.startsWith(sval(a[0]));
    case 'endswith': return s.endsWith(sval(a[0]));
    case 'indexof': return s.indexOf(sval(a[0]), a.length > 1 ? toInt(a[1]) : 0);
    case 'lastindexof': return s.lastIndexOf(sval(a[0]));
    case 'tostring': return s;
    case 'normalize': return s.normalize('NFC');
    case 'getenumerator': nope('GetEnumerator');
    // eslint-disable-next-line no-fallthrough
    case 'chars': return new PSChar(s.charCodeAt(toInt(a[0])));
    case 'equals': return s === sval(a[0]);
    case 'reverse': nope('string Reverse');
    // eslint-disable-next-line no-fallthrough
    default: return nope(`string.${name}`);
  }
}

const STRING_METHODS = new Set(['replace', 'split', 'tochararray', 'substring', 'toupper', 'toupperinvariant', 'tolower', 'tolowerinvariant', 'trim',
  'trimstart', 'trimend', 'insert', 'remove', 'padleft', 'padright', 'contains', 'startswith', 'endswith', 'indexof', 'lastindexof', 'tostring',
  'normalize', 'chars', 'equals']);

function convertInt(name, a) {
  const ranges = { toint16: [-32768, 32767, 16], toint32: [-2147483648, 2147483647, 32], toint64: [-(2 ** 53), 2 ** 53, 64], tobyte: [0, 255, 8],
    tosbyte: [-128, 127, 8], touint16: [0, 65535, 16], touint32: [0, 4294967295, 32], touint64: [0, 2 ** 53, 64] };
  const [min, max, bits] = ranges[name];
  if (a.length === 2) {
    const base = toInt(a[1]);
    if (![2, 8, 10, 16].includes(base)) nope('taban');
    let s = toStr(a[0]).trim();
    if (base === 16) s = s.replace(/^0x/i, '');
    const re = { 2: /^[01]+$/, 8: /^[0-7]+$/, 10: /^-?\d+$/, 16: /^[0-9a-f]+$/i }[base];
    if (!re.test(s)) nope('sayı biçimi');
    let n = parseInt(s, base);
    // 2/8/16 tabanında bit deseni olarak okunur (iki tümleyen)
    if (base !== 10 && bits < 64 && min < 0 && n > max && n < 2 ** bits) n -= 2 ** bits;
    if (n < min || n > max) nope('taşma');
    return n;
  }
  const v = a[0];
  if (v instanceof PSChar) return toInt(v.code, min, max);
  return toInt(v, min, max);
}

function staticMember(key, name, args, ev) {
  const a = args;
  const call = a !== null;
  switch (key) {
    case 'convert':
      if (!call) break;
      switch (name) {
        case 'frombase64string':
          try { return base64Decode(toStr(a[0])); } catch (e) { if (e instanceof CodecError) nope(e.message); throw e; }
        case 'tobase64string': return checkString(base64Encode(toBytes(a[0])));
        case 'toint16': case 'toint32': case 'toint64': case 'tobyte': case 'tosbyte': case 'touint16': case 'touint32': case 'touint64':
          return convertInt(name, a);
        case 'tochar': return new PSChar(a[0] instanceof PSChar ? a[0].code : toInt(a[0], 0, 65535));
        case 'tostring': {
          if (a.length === 2) {
            const base = toInt(a[1]);
            if (![2, 8, 10, 16].includes(base)) nope('taban');
            return toInt(a[0]).toString(base);
          }
          return toStr(a[0]);
        }
        default: break;
      }
      break;
    case 'string':
      if (!call) break;
      if (name === 'join') {
        const sep = toStr(a[0]);
        const items = a.length === 2 ? enumerate(a[1]) : a.slice(1);
        return checkString(items.map(sval).join(sep));
      }
      if (name === 'concat') return checkString((a.length === 1 ? enumerate(a[0]) : a).map(sval).join(''));
      if (name === 'format') return netFormat(toStr(a[0]), a.length === 2 && Array.isArray(a[1]) ? a[1] : a.slice(1));
      if (name === 'new') return construct('string', a);
      if (name === 'isnullorempty') return a[0] === null || toStr(a[0]) === '';
      break;
    case 'char':
      if (!call) break;
      if (name === 'convertfromutf32') return String.fromCodePoint(toInt(a[0], 0, 0x10ffff));
      if (name === 'tostring') return sval(a[0]);
      if (name === 'parse') return cast('char', toStr(a[0]));
      break;
    case 'text.encoding':
      if (!call) {
        const e = encodingName(name);
        if (e) return new Obj('encoding', { enc: e });
        break;
      }
      if (name === 'getencoding') return enc(toStr(a[0]));
      break;
    case 'text.regularexpressions.regex':
      if (!call) break;
      if (name === 'matches') {
        const opts = a.length > 2 ? toStr(a[2]).toLowerCase() : '';
        const rtl = opts.includes('righttoleft');
        const flags = `g${opts.includes('ignorecase') ? 'i' : ''}`;
        const pattern = toStr(a[1]);
        // RightToLeft yalnızca tek karakterlik desenlerde soldan eşleşmenin tersidir
        if (rtl && !/^(?:\.|\\.|\[[^\]]+\]|\w)$/.test(pattern)) nope('RightToLeft deseni');
        const re = netRegex(pattern, `${flags}s`.replace('ss', 's'));
        const input = toStr(a[0]);
        const out = [];
        for (const m of input.matchAll(re)) {
          ev.budget.tick();
          if (m[0] === '' ) { if (out.length > MAX_ARRAY) nope('çok eşleşme'); }
          out.push(new Obj('match', { value: m[0], index: m.index }));
          if (out.length > MAX_ARRAY) nope('çok eşleşme');
        }
        if (/singleline/.test(opts) === false && pattern === '.') {
          // '.' satır sonu dışındaki karakterler (s bayrağı olmadan)
          const plain = out.filter((m) => m.value !== '\n');
          return rtl ? plain.reverse() : plain;
        }
        return rtl ? out.reverse() : out;
      }
      if (name === 'replace') return checkString(toStr(a[0]).replace(netRegex(toStr(a[1]), 'g'), netReplacement(toStr(a[2]))));
      if (name === 'split') return toStr(a[0]).split(netRegex(toStr(a[1]), ''));
      if (name === 'escape') return toStr(a[0]).replace(/[\\*+?|{[()^$.#\s]/g, (c) => (c === ' ' ? '\\ ' : c === '\t' ? '\\t' : c === '\n' ? '\\n' : `\\${c}`));
      if (name === 'unescape') return toStr(a[0]).replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (m, e) => (e[0] === 'u' || e[0] === 'x' ? String.fromCharCode(parseInt(e.slice(1), 16)) : { n: '\n', t: '\t', r: '\r' }[e] ?? e));
      break;
    case 'runtime.interopservices.marshal':
      if (!call) break;
      if (/^securestringto(?:bstr|globalallocunicode|cotaskmemunicode|globalallocansi|cotaskmemansi)$/.test(name)) {
        if (!isObj(a[0], 'securestring')) nope('SecureString değil');
        return new Obj('bstr', { value: a[0].value });
      }
      if (/^ptrtostring(?:auto|bstr|uni|ansi)$/.test(name)) {
        if (!isObj(a[0], 'bstr')) nope('BSTR değil');
        return a.length > 1 ? a[0].value.slice(0, toInt(a[1])) : a[0].value;
      }
      break;
    case 'management.automation.scriptblock':
      if (call && name === 'create') return new Obj('scriptblock', { text: toStr(a[0]), created: true });
      break;
    case 'environment':
      if (call && name === 'getenvironmentvariable') {
        const v = AUTOMATIC[`env:${toStr(a[0]).toLowerCase()}`];
        return v === undefined ? nope('ortam değişkeni') : v;
      }
      break;
    case 'io.compression.compressionmode':
      if (!call && (name === 'decompress' || name === 'compress')) return new Obj('enum', { type: 'CompressionMode', name: name === 'decompress' ? 'Decompress' : 'Compress', value: name === 'decompress' ? 0 : 1 });
      break;
    case 'int32': case 'int16': case 'int64': case 'byte': case 'uint32': case 'double':
      if (call && name === 'parse') return cast(key, toStr(a[0]).trim());
      if (!call && name === 'maxvalue') return { int32: 2147483647, int16: 32767, byte: 255, uint32: 4294967295 }[key] ?? nope('MaxValue');
      break;
    default:
      break;
  }
  if (call && name === 'new') return construct(key, a);
  return nope(`[${key}]::${name}`);
}

function instanceMember(obj, name, args, ev) {
  const call = args !== null;
  const a = args ?? [];
  if (typeof obj === 'string') {
    if (!call) {
      if (name === 'length') return obj.length;
      if (STRING_METHODS.has(name)) return new Obj('method', { target: obj, name });
      return nope(`string.${name}`);
    }
    return stringMethod(obj, name, a);
  }
  if (obj instanceof PSChar) {
    if (call && name === 'tostring') return String.fromCharCode(obj.code);
    if (call && name === 'equals') return equals(obj.code, a[0]);
    return nope('char üyesi');
  }
  if (typeof obj === 'number') {
    if (call && name === 'tostring') return a.length ? formatValue(obj, toStr(a[0])) : toStr(obj);
    return nope('sayı üyesi');
  }
  if (Array.isArray(obj) || obj instanceof Uint8Array) {
    if (!call && (name === 'length' || name === 'count')) return obj.length;
    if (call && name === 'tostring') return obj instanceof Uint8Array ? 'System.Byte[]' : 'System.Object[]';
    if (!call && Array.isArray(obj)) {
      // üye numaralandırması: (@(m1,m2)).Value
      return collapse(obj.map((x) => instanceMember(x, name, null, ev)));
    }
    return nope('dizi üyesi');
  }
  if (!(obj instanceof Obj)) return nope('üye');
  switch (obj.kind) {
    case 'encoding':
      if (call && name === 'getstring') {
        let b = toBytes(a[0]);
        if (a.length === 3) b = b.subarray(toInt(a[1]), toInt(a[1]) + toInt(a[2]));
        return checkString(decodeText(b, obj.enc));
      }
      if (call && name === 'getbytes') {
        try { return encodeText(charsOf(a[0]), obj.enc); } catch (e) { if (e instanceof CodecError) nope(e.message); throw e; }
      }
      break;
    case 'memorystream':
      if (call && (name === 'toarray' || name === 'getbuffer')) return obj.bytes;
      if (!call && name === 'length') return obj.bytes.length;
      break;
    case 'reader':
      if (call && name === 'readtoend') return checkString(decodeText(streamBytes(obj.source), obj.enc));
      break;
    case 'securestring':
      if (!call && name === 'length') return obj.value.length;
      break;
    case 'credential':
      if (call && name === 'getnetworkcredential') return new Obj('netcred', { user: obj.user, password: obj.password.value });
      if (!call && name === 'username') return obj.user;
      if (!call && name === 'password') return obj.password;
      break;
    case 'netcred':
      if (!call && name === 'password') return obj.password;
      if (!call && name === 'username') return obj.user;
      break;
    case 'match':
      if (!call && name === 'value') return obj.value;
      if (!call && name === 'index') return obj.index;
      if (!call && name === 'length') return obj.value.length;
      if (call && name === 'tostring') return obj.value;
      break;
    case 'method':
      if (call && name === 'invoke') return obj.isStatic ? staticMember(obj.typeKey, obj.name, a, ev) : instanceMember(obj.target, obj.name, a, ev);
      if (call && name === 'tostring') return toStr(obj);
      break;
    case 'variable':
      if (!call && name === 'value') return obj.value;
      if (!call && name === 'name') return obj.name;
      break;
    case 'command':
      if (!call && name === 'name') return obj.name;
      if (call && name === 'tostring') return obj.name;
      break;
    case 'enum':
      if (call && name === 'tostring') return obj.name;
      if (!call && name === 'value__') return obj.value;
      break;
    case 'type':
      if (!call && name === 'fullname') return obj.full;
      if (!call && name === 'name') return obj.full.split('.').pop();
      if (call && name === 'tostring') return obj.full;
      break;
    case 'scriptblock':
      if (call && name === 'tostring') return obj.text;
      break;
    case 'hashtable': {
      if (!call && name === 'count') return obj.map.size;
      if (!call && obj.map.has(name)) return obj.map.get(name).value;
      break;
    }
    default:
      break;
  }
  return nope(`${obj.kind}.${name}`);
}

/** Get-Variable için betik ve otomatik değişken adları (joker eşleme) */
function variableNames(ev) {
  return [...new Set([...DEFAULT_VARIABLES, ...ev.scriptVariableNames()])];
}

// boru hattında güvenle değerlendirilebilen komutlar (takma adlar çözülür)
const PURE_COMMANDS = new Set(['foreach-object', 'where-object', 'out-string', 'write-output', 'convertto-securestring', 'new-object',
  'get-variable', 'get-item', 'get-childitem', 'get-command', 'select-object', 'sort-object']);
export const resolveAlias = (name) => {
  const n = String(name).replace(/^microsoft\.powershell\.\w+\\/i, '');
  const hit = Object.keys(ALIASES).find((k) => k.toLowerCase() === n.toLowerCase());
  return (hit ? ALIASES[hit] : n).toLowerCase();
};

/**
 * @param {object} o
 * @param {(node) => any} o.valueOf Var düğümünün o noktadaki değeri (bilinmiyorsa undefined)
 * @param {(name: string) => any} [o.nameValue] Get-Variable / variable: için ada göre değer
 * @param {() => string[]} [o.names] betikte atanan değişken adları
 * @param {object} o.budget bütçe (tick)
 */
export function createEvaluator({ valueOf, nameValue = () => undefined, names = () => [], budget, code = null }) {
  const ev = { budget, scriptVariableNames: names };

  function evalNode(node, scope) {
    budget.tick();
    switch (node.type) {
      case 'Str': {
        if (node.parts === null) return node.value;
        let out = '';
        for (const p of node.parts) {
          if (typeof p === 'string') out += p;
          // "$?": özel karakter kodlaması "True"dan harf seçer; yalnızca tek başına "$?" dizgesi için (betik başında doğru)
          else if (p.type === 'Var' && p.name === '?' && node.parts.length === 1) out += 'True';
          else out += toStr(evalNode(p, scope));
          checkString(out);
        }
        return out;
      }
      case 'Num': return node.value;
      case 'Bareword': return node.complex ? nope('karmaşık sözcük') : node.value;
      case 'Var': return varValue(node, scope);
      case 'Paren': return node.inner ? evalStatement(node.inner, scope) : null;
      case 'SubExpr': return collapse(evalStatements(node.body, scope));
      case 'ArrayExpr': return evalStatements(node.body, scope);
      case 'ArrayLit': {
        if (node.items.length > MAX_ARRAY) nope('dizi çok büyük');
        return node.items.map((x) => evalNode(x, scope));
      }
      case 'Unary': return unary(node, scope);
      case 'Binary': return binaryChain(node, scope);
      case 'Cast': {
        const key = typeKey(node.typeName);
        return cast(key, evalNode(node.operand, scope));
      }
      case 'TypeLit': return typeObj(node.name);
      case 'Member': return member(node, scope);
      case 'Index': return index(node, scope);
      case 'Hash': {
        const map = new Map();
        for (const { key, value } of node.entries) {
          const k = key.type === 'Bareword' ? key.value : toStr(evalNode(key, scope));
          map.set(k.toLowerCase(), { key: k, value: evalStatement(value, scope) });
        }
        return new Obj('hashtable', { map });
      }
      case 'ScriptBlock': return code === null ? nope('betik bloğu metni yok') : new Obj('scriptblock', { text: code.slice(node.start + 1, node.end - 1), node });
      case 'Pipeline': return evalPipeline(node, scope);
      default: return nope(`düğüm: ${node.type}`);
    }
  }

  function varValue(node, scope) {
    if (node.splat) nope('splat');
    const k = node.key;
    if (k === 'true') return true;
    if (k === 'false') return false;
    if (k === 'null') return null;
    if (k === '_' || k === 'psitem') {
      for (let s = scope; s; s = s.parent) if ('item' in s) return s.item;
      return nope('$_');
    }
    const v = valueOf(node);
    if (v === undefined) return nope(`değişken bilinmiyor: ${node.name}`);
    return v;
  }

  function evalStatement(st, scope) {
    if (st.type === 'Pipeline') return evalPipeline(st, scope);
    return nope(`deyim: ${st.type}`);
  }

  function evalStatements(list, scope) {
    const out = [];
    for (const st of list.stmts) {
      if (st.type !== 'Pipeline') nope('deyim');
      const v = evalPipelineItems(st, scope);
      out.push(...v);
      if (out.length > MAX_ARRAY) nope('dizi çok büyük');
    }
    return out;
  }

  // boru hattının çıktı öğeleri
  function evalPipelineItems(p, scope) {
    if (p.redirs?.length || p.background) nope('yönlendirme');
    let items = null;
    for (let i = 0; i < p.elements.length; i++) {
      const el = p.elements[i];
      if (el.type === 'Command') items = evalCommand(el, items, scope);
      else {
        if (i > 0) nope('ifade boru hattının ortasında');
        items = enumerate(evalNode(el, scope));
      }
    }
    return items;
  }

  function evalPipeline(p, scope) {
    // tek ifadeli boru hattı türünü korur (bayt dizisi, tek öğeli dizi)
    if (p.elements.length === 1 && p.elements[0].type !== 'Command' && !p.redirs?.length && !p.background) return evalNode(p.elements[0], scope);
    return collapse(evalPipelineItems(p, scope));
  }

  function unary(node, scope) {
    const v = evalNode(node.operand, scope);
    switch (node.op) {
      case '-': return -toNum(v);
      case '+': return toNum(v);
      case '-not': return !toBool(v);
      case '-bnot': return ~toInt(v);
      case ',': return [v];
      case '-join': return checkString(enumerate(v).map(sval).join(''));
      case '-split': case '-isplit': case '-csplit': return enumerate(v).flatMap((x) => sval(x).split(/\s+/).filter((y, i, arr) => y !== '' || (i > 0 && i < arr.length - 1)));
      default: return nope(`tekli: ${node.op}`);
    }
  }

  // sol omurga yinelemeli: 'a'+'b'+'c'... binlerce düzeyde yığın taşmaz
  function binaryChain(node, scope) {
    const chain = [];
    let n = node;
    while (n.type === 'Binary') { chain.push(n); n = n.left; }
    let left = evalNode(n, scope);
    for (let i = chain.length - 1; i >= 0; i--) {
      budget.tick();
      left = binary(chain[i].op, left, evalNode(chain[i].right, scope));
    }
    return left;
  }

  function binary(op, l, r) {
    switch (op) {
      case '+': return add(l, r);
      case '-': return toNum(l) - toNum(r);
      case '*': {
        if (typeof l === 'string') {
          const n = toInt(r);
          if (n < 0 || l.length * n > MAX_STRING) nope('tekrar çok büyük');
          return l.repeat(n);
        }
        if (Array.isArray(l)) {
          const n = toInt(r);
          if (n < 0 || l.length * n > MAX_ARRAY) nope('tekrar çok büyük');
          return Array.from({ length: n }, () => l).flat();
        }
        return toNum(l) * toNum(r);
      }
      case '/': {
        const d = toNum(r);
        if (d === 0) nope('sıfıra bölme');
        return toNum(l) / d;
      }
      case '%': {
        const d = toNum(r);
        if (d === 0) nope('sıfıra bölme');
        return toNum(l) % d;
      }
      case '-f': return netFormat(toStr(l), Array.isArray(r) ? r : [r]);
      case '-join': return checkString(enumerate(l).map(sval).join(toStr(r)));
      case '-split': case '-isplit': case '-csplit': {
        const args = Array.isArray(r) ? r : [r];
        if (args.length > 1) nope('-split sayaç');
        const re = netRegex(toStr(args[0]), op === '-csplit' ? '' : 'i');
        return enumerate(l).flatMap((x) => sval(x).split(re).map((y) => (y === undefined ? '' : y)));
      }
      case '-replace': case '-ireplace': case '-creplace': {
        const args = Array.isArray(r) ? r : [r];
        if (args.length > 2) nope('-replace');
        if (isObj(args[1], 'scriptblock')) nope('-replace scriptblock');
        const re = netRegex(toStr(args[0]), op === '-creplace' ? 'g' : 'gi');
        const repl = netReplacement(args.length > 1 ? toStr(args[1]) : '');
        const one = (x) => checkString(sval(x).replace(re, repl));
        return Array.isArray(l) ? l.map(one) : one(l);
      }
      case '-band': return toInt(l, -(2 ** 31), 2 ** 32) & toInt(r, -(2 ** 31), 2 ** 32);
      case '-bor': return toInt(l, -(2 ** 31), 2 ** 32) | toInt(r, -(2 ** 31), 2 ** 32);
      case '-bxor': return toInt(l, -(2 ** 31), 2 ** 32) ^ toInt(r, -(2 ** 31), 2 ** 32);
      case '-shl': return toInt(l) << toInt(r);
      case '-shr': return toInt(l) >> toInt(r);
      case '..': {
        const a = toInt(l);
        const b = toInt(r);
        if (Math.abs(b - a) >= MAX_ARRAY) nope('aralık çok büyük');
        const out = [];
        for (let i = a; a <= b ? i <= b : i >= b; i += a <= b ? 1 : -1) out.push(i);
        return out;
      }
      case '-and': return toBool(l) && toBool(r);
      case '-or': return toBool(l) || toBool(r);
      case '-xor': return toBool(l) !== toBool(r);
      case '-as': {
        if (!isObj(r, 'type') && typeof r !== 'string') nope('-as');
        try { return cast(isObj(r, 'type') ? r.key : typeKey(r), l); } catch (e) { if (e instanceof Nope) return null; throw e; }
      }
      default: break;
    }
    const m = /^-([ic]?)(eq|ne|gt|ge|lt|le|like|notlike|contains|notcontains|in|notin)$/.exec(op);
    if (m) {
      const cs = m[1] === 'c';
      const kind = m[2];
      if (kind === 'contains' || kind === 'notcontains') { const hit = enumerate(l).some((x) => equals(x, r, cs)); return kind === 'contains' ? hit : !hit; }
      if (kind === 'in' || kind === 'notin') { const hit = enumerate(r).some((x) => equals(x, l, cs)); return kind === 'in' ? hit : !hit; }
      if (Array.isArray(l)) nope('dizi karşılaştırma');
      switch (kind) {
        case 'eq': return equals(l, r, cs);
        case 'ne': return !equals(l, r, cs);
        case 'gt': return compare(l, r, cs) > 0;
        case 'ge': return compare(l, r, cs) >= 0;
        case 'lt': return compare(l, r, cs) < 0;
        case 'le': return compare(l, r, cs) <= 0;
        case 'like': return wildcard(toStr(r)).test(toStr(l)) || (cs && false);
        case 'notlike': return !wildcard(toStr(r)).test(toStr(l));
        default: break;
      }
    }
    // -match $Matches'e yazar (yan etki); -is tür sistemi gerektirir
    return nope(`işleç: ${op}`);
  }

  function add(l, r) {
    if (l === null) return r;
    if (typeof l === 'string' || l instanceof PSChar) return checkString(sval(l) + sval(r));
    if (Array.isArray(l)) {
      const out = l.concat(Array.isArray(r) ? r : r instanceof Uint8Array ? Array.from(r) : [r]);
      if (out.length > MAX_ARRAY) nope('dizi çok büyük');
      return out;
    }
    if (l instanceof Uint8Array) return add(Array.from(l), r);
    if (typeof l === 'number' || typeof l === 'boolean') return toNum(l) + toNum(r);
    return nope('+ desteklenmiyor');
  }

  function memberName(node, scope) {
    if (node.name !== null) return node.name.toLowerCase();
    const v = evalNode(node.nameNode, scope);
    return toStr(v).toLowerCase();
  }

  function member(node, scope) {
    const name = memberName(node, scope);
    const args = node.args === null ? null : node.args.map((x) => evalNode(x, scope));
    if (node.static) {
      const t = node.object.type === 'TypeLit' ? typeKey(node.object.name) : (() => { const o = evalNode(node.object, scope); return isObj(o, 'type') ? o.key : nope('statik üye'); })();
      if (args === null && !['utf8', 'ascii', 'unicode', 'bigendianunicode', 'utf32', 'default', 'decompress', 'compress', 'maxvalue'].includes(name)) {
        return new Obj('method', { isStatic: true, typeKey: t, name });
      }
      return staticMember(t, name, args, ev);
    }
    const obj = evalNode(node.object, scope);
    if (isObj(obj, 'type')) {
      // [tip] nesnesi üzerinden statik çağrı: ([type]'Convert')::FromBase64String yerine .FromBase64String
      if (args !== null) return staticMember(obj.key, name, args, ev);
    }
    return instanceMember(obj, name, args, ev);
  }

  function index(node, scope) {
    const obj = evalNode(node.object, scope);
    const idx = evalStatement(node.index, scope);
    const one = (i) => {
      if (isObj(obj, 'hashtable')) return obj.map.get(toStr(i).toLowerCase())?.value ?? null;
      let n = toInt(i);
      const len = typeof obj === 'string' || Array.isArray(obj) || obj instanceof Uint8Array ? obj.length : nope('indekslenemez');
      if (n < 0) n += len;
      if (n < 0 || n >= len) return undefined;
      if (typeof obj === 'string') return new PSChar(obj.charCodeAt(n));
      return obj[n];
    };
    if (Array.isArray(idx)) return idx.map(one).filter((x) => x !== undefined);
    const v = one(idx);
    return v === undefined ? null : v;
  }

  // ── komutlar (yalnızca yan etkisizler) ──
  function argList(cmd, scope) {
    // { positional: [değer], named: Map<küçük ad, değer|true> }
    const positional = [];
    const named = new Map();
    for (let i = 0; i < cmd.args.length; i++) {
      const a = cmd.args[i];
      if (a.type === 'Param') {
        const name = a.name.toLowerCase();
        if (a.value) { named.set(name, evalNode(a.value, scope)); continue; }
        const next = cmd.args[i + 1];
        named.set(name, next && next.type !== 'Param' ? { pending: next } : true);
        if (next && next.type !== 'Param') i++;
        continue;
      }
      if (a.type === 'Redirect') nope('yönlendirme');
      positional.push(evalNode(a, scope));
    }
    // anahtarlar (switch) ile değerli parametreleri ayırmak için ad bilgisine göre çağıran çözer
    return { positional, named };
  }

  const prefix = (name, full, min = 1) => name.length >= min && full.startsWith(name);
  function getNamed(args, names, scope, { switchParam = false } = {}) {
    for (const [k, v] of args.named) {
      if (!names.some(([full, min]) => prefix(k, full, min))) continue;
      if (switchParam) {
        if (v && typeof v === 'object' && 'pending' in v) {
          // anahtar parametre değer almaz: bekleyen argüman konumsaldır
          args.positional.push(evalNode(v.pending, scope));
          args.named.set(k, true);
        }
        return true;
      }
      if (v === true) nope('parametre değeri yok');
      return v && typeof v === 'object' && 'pending' in v ? evalNode(v.pending, scope) : v;
    }
    return undefined;
  }
  const leftover = (args, known) => {
    for (const k of args.named.keys()) if (!known.some(([full, min]) => prefix(k, full, min))) nope(`bilinmeyen parametre -${k}`);
  };

  function evalCommand(cmd, input, scope) {
    if (cmd.invoke || cmd.name.type !== 'Bareword' || cmd.name.complex || cmd.redirs.length) nope('komut');
    const name = resolveAlias(cmd.name.value);
    if (!PURE_COMMANDS.has(name)) nope(`komut: ${name}`);
    const args = argList(cmd, scope);
    switch (name) {
      case 'foreach-object': {
        if (input === null) nope('girdi yok');
        const proc = getNamed(args, [['process', 1]], scope) ?? args.positional[0];
        const memberName_ = getNamed(args, [['membername', 1]], scope);
        leftover(args, [['process', 1], ['membername', 1]]);
        if (memberName_ !== undefined || typeof proc === 'string') {
          const m = toStr(memberName_ ?? proc).toLowerCase();
          return input.flatMap((x) => enumerate(instanceMember(x, m, null, ev)));
        }
        if (!isObj(proc, 'scriptblock') || !proc.node || args.positional.length > 1) nope('ForEach-Object');
        const out = [];
        for (const item of input) {
          budget.tick();
          out.push(...runBlock(proc.node, { parent: scope, item }));
          if (out.length > MAX_ARRAY) nope('çok öğe');
        }
        return out;
      }
      case 'where-object': {
        if (input === null) nope('girdi yok');
        const block = getNamed(args, [['filterscript', 1]], scope) ?? args.positional[0];
        if (!isObj(block, 'scriptblock') || !block.node || args.positional.length > 1) nope('Where-Object');
        return input.filter((item) => toBool(collapse(runBlock(block.node, { parent: scope, item }))));
      }
      case 'out-string': {
        leftover(args, [['stream', 1], ['width', 1]]);
        if (getNamed(args, [['stream', 1]], scope, { switchParam: true })) return (input ?? []).map((x) => sval(x));
        return [`${(input ?? []).map(sval).join('\n')}\n`];
      }
      case 'write-output': {
        if (input !== null) nope('Write-Output girdisi');
        leftover(args, [['noenumerate', 1], ['inputobject', 1]]);
        const v = getNamed(args, [['inputobject', 1]], scope);
        return v !== undefined ? enumerate(v) : args.positional.flatMap(enumerate);
      }
      case 'select-object': {
        const first = getNamed(args, [['first', 1]], scope);
        const last = getNamed(args, [['last', 1]], scope);
        const skip = getNamed(args, [['skip', 2]], scope);
        leftover(args, [['first', 1], ['last', 1], ['skip', 2]]);
        if (input === null || args.positional.length) nope('Select-Object');
        let out = input.slice(skip !== undefined ? toInt(skip) : 0);
        if (first !== undefined) out = out.slice(0, toInt(first));
        if (last !== undefined) out = out.slice(-toInt(last));
        return out;
      }
      case 'sort-object': {
        const desc = getNamed(args, [['descending', 1]], scope, { switchParam: true });
        leftover(args, [['descending', 1]]);
        if (input === null || args.positional.length) nope('Sort-Object');
        const sorted = [...input].sort((x, y) => compare(x, y, false));
        return desc ? sorted.reverse() : sorted;
      }
      case 'convertto-securestring': {
        const plain = getNamed(args, [['asplaintext', 1]], scope, { switchParam: true });
        getNamed(args, [['force', 1]], scope, { switchParam: true });
        const key = getNamed(args, [['key', 1]], scope);
        const str = getNamed(args, [['string', 1]], scope);
        leftover(args, [['asplaintext', 1], ['force', 1], ['key', 1], ['string', 1]]);
        const inputs = str !== undefined ? [str] : args.positional.length ? [args.positional[0]] : input ?? nope('girdi yok');
        return inputs.map((x) => {
          const s = toStr(x);
          if (plain) return new Obj('securestring', { value: s });
          if (key === undefined) nope('DPAPI (makineye bağlı) SecureString');
          const value = decryptSecureString(s, toBytes(enumerate(key)));
          return value === null ? nope('SecureString çözülemedi') : new Obj('securestring', { value });
        });
      }
      case 'new-object': {
        if (input !== null) nope('New-Object girdisi');
        const typeName = getNamed(args, [['typename', 1]], scope) ?? args.positional.shift();
        const argListV = getNamed(args, [['argumentlist', 1]], scope) ?? args.positional.shift();
        leftover(args, [['typename', 1], ['argumentlist', 1]]);
        if (args.positional.length || typeName === undefined) nope('New-Object');
        const key = isObj(typeName, 'type') ? typeName.key : typeKey(toStr(typeName));
        const ctorArgs = argListV === undefined ? [] : Array.isArray(argListV) ? argListV : [argListV];
        return [construct(key, ctorArgs)];
      }
      case 'get-variable': {
        if (input !== null) nope('Get-Variable girdisi');
        const pattern = getNamed(args, [['name', 1]], scope) ?? args.positional[0];
        const valueOnly = getNamed(args, [['valueonly', 1]], scope, { switchParam: true });
        leftover(args, [['name', 1], ['valueonly', 1]]);
        if (pattern === undefined || args.positional.length > 1) nope('Get-Variable');
        const re = wildcard(toStr(pattern));
        const hits = variableNames(ev).filter((n) => re.test(n));
        if (hits.length !== 1) nope('Get-Variable eşleşmesi tekil değil');
        const v = variableValue(hits[0]);
        return [valueOnly ? v : new Obj('variable', { name: hits[0], value: v })];
      }
      case 'get-item': case 'get-childitem': {
        if (input !== null) nope('girdi');
        const path = getNamed(args, [['path', 1], ['literalpath', 1]], scope) ?? args.positional[0];
        leftover(args, [['path', 1], ['literalpath', 1]]);
        const m = /^(variable|env):\\?([\w*?]+)$/i.exec(toStr(path ?? ''));
        if (!m || args.positional.length > 1) nope('Get-Item yolu');
        if (m[1].toLowerCase() === 'env') {
          const v = AUTOMATIC[`env:${m[2].toLowerCase()}`] ?? nameValue(`env:${m[2]}`);
          if (v === undefined) nope('ortam değişkeni');
          return [new Obj('variable', { name: m[2], value: v })];
        }
        const re = wildcard(m[2]);
        const hits = variableNames(ev).filter((n) => re.test(n));
        if (hits.length !== 1) nope('değişken eşleşmesi tekil değil');
        return [new Obj('variable', { name: hits[0], value: variableValue(hits[0]) })];
      }
      case 'get-command': {
        if (input !== null) nope('girdi');
        const pattern = getNamed(args, [['name', 1]], scope) ?? args.positional[0];
        leftover(args, [['name', 1]]);
        if (pattern === undefined || args.positional.length > 1) nope('Get-Command');
        const p = toStr(pattern);
        if (!/[*?]/.test(p)) return [new Obj('command', { name: p })];
        const re = wildcard(p);
        const hits = [...COMMANDS, ...Object.keys(ALIASES)].filter((n) => re.test(n));
        if (hits.length !== 1) nope('Get-Command eşleşmesi tekil değil');
        return [new Obj('command', { name: hits[0] })];
      }
      default:
        return nope(name);
    }
  }

  function variableValue(name) {
    const v = nameValue(name);
    if (v !== undefined) return v;
    const a = AUTOMATIC[name.toLowerCase()];
    if (a !== undefined) return a;
    if (/^(true|false|null)$/i.test(name)) return { true: true, false: false, null: null }[name.toLowerCase()];
    return nope(`değişken değeri bilinmiyor: ${name}`);
  }

  // ForEach-Object / Where-Object betik bloğu: yalnızca ifade deyimleri
  function runBlock(blockNode, scope) {
    const out = [];
    for (const st of blockNode.body.stmts) {
      if (st.type !== 'Pipeline') nope('betik bloğunda deyim');
      out.push(...evalPipelineItems(st, scope));
    }
    return out;
  }

  return {
    /** Değer ya da Nope/BudgetError */
    eval(node, item) {
      try {
        return evalNode(node, item === undefined ? null : { parent: null, item });
      } catch (e) {
        if (e instanceof RangeError) throw new Nope('yığın taşması');
        throw e;
      }
    },
    /** { ok, value } — Nope ve RangeError yutulur, bütçe hatası geçer */
    tryEval(node) {
      try {
        return { ok: true, value: evalNode(node, null) };
      } catch (e) {
        if (e instanceof Nope || e instanceof RangeError) return { ok: false, why: e.message };
        throw e;
      }
    },
    construct,
    streamBytes,
    binary,
    cast,
  };
}

export { Nope, BudgetError };
