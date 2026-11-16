// Bayt kodlamaları: base64 (.NET Convert kuralları), metin kodlamaları (.NET Encoding adları), raw deflate ve gzip
// açma (sınırlı çıktı). Tarayıcıda ve Node'da aynı çalışır (Buffer kullanılmaz).
import { Inflate, Gunzip } from 'fflate';

export class CodecError extends Error {}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Int16Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) B64_INDEX[B64.charCodeAt(i)] = i;

/** Convert.FromBase64String: boşluklar yok sayılır, uzunluk 4'ün katı olmalı, geçersiz karakter hatadır */
export function base64Decode(text) {
  const s = String(text).replace(/[\s]+/g, '');
  if (s.length % 4 !== 0) throw new CodecError('base64 uzunluğu geçersiz');
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    let v = 0;
    for (let k = 0; k < 4; k++) {
      const ch = s.charCodeAt(i + k);
      let d;
      if (ch === 61) {
        if (i + 4 !== s.length || k < 2) throw new CodecError('base64 dolgusu geçersiz');
        d = 0;
      } else {
        d = ch < 128 ? B64_INDEX[ch] : -1;
        if (d < 0) throw new CodecError('base64 karakteri geçersiz');
      }
      v = (v << 6) | d;
    }
    if (o < out.length) out[o++] = (v >> 16) & 255;
    if (o < out.length) out[o++] = (v >> 8) & 255;
    if (o < out.length) out[o++] = v & 255;
  }
  return out;
}

export function base64Encode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : B64[c & 63];
  }
  return out;
}

/** .NET kodlama adı → kanonik ad; bilinmiyorsa null */
export function encodingName(name) {
  const n = String(name).toLowerCase().replace(/[-_\s]/g, '');
  if (['utf8', 'utf8encoding', 'system.text.utf8encoding', '65001'].includes(n)) return 'UTF8';
  if (['ascii', 'usascii', 'asciiencoding', 'system.text.asciiencoding', '20127'].includes(n)) return 'ASCII';
  if (['unicode', 'utf16', 'utf16le', 'unicodeencoding', 'system.text.unicodeencoding', '1200'].includes(n)) return 'Unicode';
  if (['bigendianunicode', 'utf16be', 'unicodefffe', '1201'].includes(n)) return 'BigEndianUnicode';
  if (['utf32', 'utf32le', 'utf32encoding', '12000'].includes(n)) return 'UTF32';
  // Windows PowerShell 5.1'de [Text.Encoding]::Default ANSI kod sayfasıdır (çoğunlukla 1252)
  if (['default', 'windows1252', '1252', 'latin1', 'iso88591', '28591'].includes(n)) return 'Default';
  return null;
}

const decoders = new Map();
const decoderFor = (label) => {
  if (!decoders.has(label)) decoders.set(label, new TextDecoder(label));
  return decoders.get(label);
};

/** bytes → metin (.NET Encoding.GetString davranışı) */
export function decodeText(bytes, enc) {
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  switch (enc) {
    case 'UTF8': return decoderFor('utf-8').decode(b);
    case 'Unicode': return decoderFor('utf-16le').decode(b);
    case 'BigEndianUnicode': return decoderFor('utf-16be').decode(b);
    case 'ASCII': {
      // .NET ASCIIEncoding: 127'den büyük baytlar '?'
      let s = '';
      for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192).map((x) => (x > 127 ? 63 : x)));
      return s;
    }
    case 'UTF32': {
      let s = '';
      for (let i = 0; i + 3 < b.length; i += 4) {
        const cp = b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
        s += cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '�';
      }
      return s;
    }
    case 'Default': return decoderFor('windows-1252').decode(b);
    default: throw new CodecError(`kodlama desteklenmiyor: ${enc}`);
  }
}

/** metin → bytes (.NET Encoding.GetBytes) */
export function encodeText(text, enc) {
  const s = String(text);
  switch (enc) {
    case 'UTF8': return new TextEncoder().encode(s);
    case 'ASCII': return Uint8Array.from(s, (c) => (c.charCodeAt(0) > 127 ? 63 : c.charCodeAt(0)));
    case 'Unicode':
    case 'BigEndianUnicode': {
      const out = new Uint8Array(s.length * 2);
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        const [lo, hi] = [c & 255, c >> 8];
        out[i * 2] = enc === 'Unicode' ? lo : hi;
        out[i * 2 + 1] = enc === 'Unicode' ? hi : lo;
      }
      return out;
    }
    case 'Default': {
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c > 255) throw new CodecError('ANSI dışı karakter');
        out[i] = c;
      }
      return out;
    }
    default: throw new CodecError(`kodlama desteklenmiyor: ${enc}`);
  }
}

/** Sınırlı açma: çıktı max baytı aşarsa CodecError (sıkıştırma bombası koruması) */
function inflateWith(Ctor, bytes, max) {
  const chunks = [];
  let total = 0;
  const z = new Ctor((chunk) => {
    total += chunk.length;
    if (total > max) throw new CodecError(`açılan veri ${max} baytı aşıyor`);
    // fflate iç arabelleği yeniden kullanabilir: parça kopyalanır
    chunks.push(chunk.slice());
  });
  try {
    z.push(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes), true);
  } catch (e) {
    if (e instanceof CodecError) throw e;
    throw new CodecError(`açılamadı: ${e.message}`);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export const inflateRaw = (bytes, max = 64 * 1024 * 1024) => inflateWith(Inflate, bytes, max);
export const gunzip = (bytes, max = 64 * 1024 * 1024) => inflateWith(Gunzip, bytes, max);
