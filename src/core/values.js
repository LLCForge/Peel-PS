// Statik değerlendiricinin değer modeli: PowerShell değerlerinin JavaScript karşılıkları ve dönüşümleri.
//   string, number, boolean, null          doğrudan
//   PSChar                                 [char]
//   Array                                  object[] (iç içe olabilir)
//   Uint8Array                             byte[]
//   Obj { kind, ... }                      bilinen .NET nesneleri (tür, kodlama, akış, SecureString, eşleşme...)
// Değerlendirilemeyen her şey Nope fırlatır; çağıran düğümü olduğu gibi bırakır.
import { psQuote } from './ps.js';

export class Nope extends Error {
  constructor(why = 'statik değil') { super(why); }
}
export class BudgetError extends Error {}
export const nope = (why) => { throw new Nope(why); };

export class PSChar {
  constructor(code) { this.code = code; }
  toString() { return String.fromCharCode(this.code); }
}

export class Obj {
  constructor(kind, data = {}) {
    this.kind = kind;
    Object.assign(this, data);
  }
}

export const MAX_STRING = 32 * 1024 * 1024;
export const MAX_ARRAY = 1_000_000;

export const isObj = (v, kind) => v instanceof Obj && (!kind || v.kind === kind);

// PowerShell 5.1'de yöntem grubunun dizge hâli (OverloadDefinitions); Invoke-Obfuscation özel karakter kodlaması
// "iex"in harflerini bunlardan seçer
const OVERLOADS = {
  insert: 'string Insert(int startIndex, string value)',
  normalize: 'string Normalize(), string Normalize(System.Text.NormalizationForm normalizationForm)',
  replace: 'string Replace(char oldChar, char newChar), string Replace(string oldValue, string newValue)',
};

const ENCODING_TYPES = {
  UTF8: 'System.Text.UTF8Encoding', ASCII: 'System.Text.ASCIIEncoding', Unicode: 'System.Text.UnicodeEncoding',
  BigEndianUnicode: 'System.Text.UnicodeEncoding', UTF32: 'System.Text.UTF32Encoding', Default: 'System.Text.SBCSCodePageEncoding',
};

export function numToStr(n) {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  if (Number.isFinite(n) && Math.abs(n) >= 1e-5 && Math.abs(n) < 1e15) return String(n);
  return nope('sayı biçimi');
}

/** PowerShell dizge dönüşümü ($OFS boşluk) */
export function toStr(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return numToStr(v);
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (v instanceof PSChar) return String.fromCharCode(v.code);
  if (Array.isArray(v)) return v.map(toStr).join(' ');
  if (v instanceof Uint8Array) return Array.from(v).join(' ');
  if (v instanceof Obj) {
    switch (v.kind) {
      case 'type': return v.full;
      case 'encoding': return ENCODING_TYPES[v.enc];
      case 'memorystream': return 'System.IO.MemoryStream';
      case 'securestring': return 'System.Security.SecureString';
      case 'match': return v.value;
      case 'method': {
        const o = !v.isStatic && typeof v.target === 'string' ? OVERLOADS[v.name.toLowerCase()] : null;
        return o ?? nope('yöntem grubu');
      }
      case 'scriptblock': return v.text;
      case 'enum': return v.name;
      case 'command': return v.name;
      case 'hashtable': return 'System.Collections.Hashtable';
      case 'variable': return 'System.Management.Automation.PSVariable';
      default: return nope(`${v.kind} dizgeye çevrilemez`);
    }
  }
  return nope('dizge dönüşümü');
}

/** Sayı dönüşümü ('0x4B' ve ondalık dizgeler dahil) */
export function toNum(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === undefined) return 0;
  if (v instanceof PSChar) return v.code;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return 0;
    let m = /^([-+]?)0x([0-9a-f]+)$/i.exec(s);
    if (m) return (m[1] === '-' ? -1 : 1) * parseInt(m[2], 16);
    m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.exec(s);
    if (m) return Number(s);
    return nope('sayıya çevrilemez');
  }
  if (v instanceof Obj && v.kind === 'enum' && typeof v.value === 'number') return v.value;
  if (Array.isArray(v) && v.length === 1) return toNum(v[0]);
  return nope('sayıya çevrilemez');
}

/** .NET tamsayı dönüşümü: yarımlar çifte yuvarlanır */
export function toInt(v, min = -2147483648, max = 2147483647) {
  let n = toNum(v);
  if (!Number.isInteger(n)) {
    const f = Math.floor(n);
    const d = n - f;
    n = d > 0.5 || (d === 0.5 && f % 2 !== 0) ? f + 1 : f;
  }
  if (n < min || n > max) return nope('tamsayı aralık dışı');
  return n;
}

export function toBool(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (v instanceof PSChar) return true;
  if (Array.isArray(v)) return v.length === 0 ? false : v.length === 1 ? toBool(v[0]) : true;
  if (v instanceof Uint8Array) return v.length === 0 ? false : v.length === 1 ? v[0] !== 0 : true;
  return true;
}

/** Boru hattında açılan öğeler */
export function enumerate(v) {
  if (Array.isArray(v)) return v;
  if (v instanceof Uint8Array) return Array.from(v);
  if (v === null || v === undefined) return [];
  return [v];
}

/** Boru hattı çıktısı: tek öğe tekil, çok öğe dizi, hiç öğe $null */
export const collapse = (items) => (items.length === 0 ? null : items.length === 1 ? items[0] : items);

export function checkString(s) {
  if (typeof s === 'string' && s.length > MAX_STRING) throw new BudgetError(`dizge ${MAX_STRING} karakteri aşıyor`);
  return s;
}

export function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) {
    const out = new Uint8Array(v.length);
    for (let i = 0; i < v.length; i++) {
      const n = toInt(v[i], 0, 255);
      out[i] = n;
    }
    return out;
  }
  return nope('bayt dizisi değil');
}

/** Katlanmış değerin PowerShell kaynak hâli; yazdırılamıyorsa null */
export function literal(v, { charAsString = true } = {}) {
  if (typeof v === 'string') return psQuote(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    if (Number.isInteger(v)) return Math.abs(v) < 1e15 ? String(v) : null;
    const s = String(v);
    return /e/i.test(s) ? null : s;
  }
  if (typeof v === 'boolean') return v ? '$true' : '$false';
  if (v instanceof PSChar) return charAsString ? psQuote(String.fromCharCode(v.code)) : `[char]${psQuote(String.fromCharCode(v.code))}`;
  if (Array.isArray(v)) {
    if (v.length > 256) return null;
    const items = v.map((x) => (Array.isArray(x) ? null : literal(x, { charAsString: false })));
    if (items.some((x) => x === null)) return null;
    return `@(${items.join(', ')})`;
  }
  if (v instanceof Obj && v.kind === 'type' && /^[\w.]+(?:\[\])?$/.test(v.display)) return `[${v.display}]`;
  if (v instanceof Obj && v.kind === 'scriptblock') return `{${v.text}}`;
  return null;
}
