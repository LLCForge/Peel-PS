// ConvertTo-SecureString -Key çözümü. ConvertFrom-SecureString -Key çıktısı:
//   "76492d1116743f0423413b16050a5345" + base64(UTF-16LE("2|" + base64(IV) + "|" + onaltılık(şifreli metin)))
// Şifreli metin, UTF-16LE düz metnin AES-CBC (PKCS7) ile anahtarla şifrelenmiş hâlidir. Anahtar 16, 24 ya da 32 bayttır.
// Değerlendirici eşzamanlı olduğundan (WebCrypto eşzamansız) AES çözme burada saf JavaScript'tir.
import { base64Decode, decodeText } from './codec.js';

export const SECURESTRING_MAGIC = '76492d1116743f0423413b16050a5345';

const SBOX = new Uint8Array(256);
const INV = new Uint8Array(256);
(() => {
  // GF(2^8) üs/log tablolarıyla S-kutusu
  const exp = new Uint8Array(256);
  const log = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    exp[i] = x;
    log[x] = i;
    x ^= (x << 1) ^ (x & 0x80 ? 0x11b : 0);
    x &= 255;
  }
  for (let i = 0; i < 256; i++) {
    let inv = i === 0 ? 0 : exp[(255 - log[i]) % 255];
    let s = inv;
    for (let k = 0; k < 4; k++) { inv = ((inv << 1) | (inv >> 7)) & 255; s ^= inv; }
    s ^= 0x63;
    SBOX[i] = s;
    INV[s] = i;
  }
})();

const xtime = (a) => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 255;
const mul = (a, b) => {
  let r = 0;
  while (b) { if (b & 1) r ^= a; a = xtime(a); b >>= 1; }
  return r;
};

function expandKey(key) {
  const nk = key.length / 4;
  const rounds = nk + 6;
  const w = new Uint8Array(16 * (rounds + 1));
  w.set(key);
  let rcon = 1;
  for (let i = nk; i < 4 * (rounds + 1); i++) {
    let t = w.slice((i - 1) * 4, i * 4);
    if (i % nk === 0) {
      t = Uint8Array.of(SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]);
      rcon = xtime(rcon);
    } else if (nk > 6 && i % nk === 4) {
      t = t.map((b) => SBOX[b]);
    }
    for (let k = 0; k < 4; k++) w[i * 4 + k] = w[(i - nk) * 4 + k] ^ t[k];
  }
  return { w, rounds };
}

function decryptBlock(block, { w, rounds }) {
  const s = Uint8Array.from(block);
  const addKey = (r) => { for (let k = 0; k < 16; k++) s[k] ^= w[r * 16 + k]; };
  addKey(rounds);
  for (let r = rounds - 1; r >= 0; r--) {
    // ters satır kaydırma + ters S-kutusu
    const t = Uint8Array.from(s);
    for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) s[((c + row) % 4) * 4 + row] = INV[t[c * 4 + row]];
    addKey(r);
    if (r === 0) break;
    for (let c = 0; c < 4; c++) {
      const [a, b, d, e] = [s[c * 4], s[c * 4 + 1], s[c * 4 + 2], s[c * 4 + 3]];
      s[c * 4] = mul(a, 14) ^ mul(b, 11) ^ mul(d, 13) ^ mul(e, 9);
      s[c * 4 + 1] = mul(a, 9) ^ mul(b, 14) ^ mul(d, 11) ^ mul(e, 13);
      s[c * 4 + 2] = mul(a, 13) ^ mul(b, 9) ^ mul(d, 14) ^ mul(e, 11);
      s[c * 4 + 3] = mul(a, 11) ^ mul(b, 13) ^ mul(d, 9) ^ mul(e, 14);
    }
  }
  return s;
}

/** AES-CBC + PKCS7 çözme; dolgu bozuksa (yanlış anahtar) null */
export function aesCbcDecrypt(data, key, iv) {
  if (![16, 24, 32].includes(key.length) || iv.length !== 16 || !data.length || data.length % 16) return null;
  const ks = expandKey(key);
  const out = new Uint8Array(data.length);
  let prev = iv;
  for (let i = 0; i < data.length; i += 16) {
    const block = data.subarray(i, i + 16);
    const plain = decryptBlock(block, ks);
    for (let k = 0; k < 16; k++) out[i + k] = plain[k] ^ prev[k];
    prev = block;
  }
  const pad = out[out.length - 1];
  if (pad < 1 || pad > 16 || out.subarray(out.length - pad).some((b) => b !== pad)) return null;
  return out.subarray(0, out.length - pad);
}

/** ConvertFrom-SecureString -Key çıktısını anahtarla çözer; biçim ya da anahtar uymazsa null */
export function decryptSecureString(text, keyBytes) {
  const s = String(text).trim();
  if (!s.toLowerCase().startsWith(SECURESTRING_MAGIC)) return null;
  let inner;
  try {
    inner = decodeText(base64Decode(s.slice(SECURESTRING_MAGIC.length)), 'Unicode');
  } catch {
    return null;
  }
  const parts = inner.split('|');
  if (parts.length !== 3 || parts[0] !== '2' || !/^(?:[0-9a-f]{2})+$/i.test(parts[2])) return null;
  let iv;
  try { iv = base64Decode(parts[1]); } catch { return null; }
  const data = Uint8Array.from(parts[2].match(/../g), (h) => parseInt(h, 16));
  const plain = aesCbcDecrypt(data, Uint8Array.from(keyBytes), iv);
  return plain ? decodeText(plain, 'Unicode') : null;
}
