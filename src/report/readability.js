// Okunabilirlik puanı (0-100): kodun ne kadar "insan yazısı" göründüğünün kaba ölçüsü. Gizleme imleri puandan düşer:
// simge yoğunluğu, ters tırnaklar, rastgele büyük/küçük harf, uzun base64/onaltılık bloklar, {0}{1} biçim parçaları,
// çok uzun satırlar ve kısa dizge birleştirmeleri. Aynı betiğin girdi ve çıktı puanları karşılaştırılmak içindir;
// mutlak bir kalite ölçüsü değildir.
import { segments } from '../core/lex.js';
import { COMMANDS } from '../core/known.js';

const CMD = new Set(COMMANDS.map((c) => c.toLowerCase()));

const clamp = (x) => Math.max(0, Math.min(100, Math.round(x)));

export function readability(code) {
  const s = String(code ?? '');
  if (!s.trim()) return 100;
  const sample = s.length > 2_000_000 ? s.slice(0, 2_000_000) : s;
  let codeText = '';
  let strings = 0;
  for (const seg of segments(sample)) {
    const t = sample.slice(seg.start, seg.end);
    if (seg.kind === 'code' || seg.kind === 'bvar') codeText += t;
    else if (seg.kind !== 'comment') strings += t.length;
  }
  const len = Math.max(1, sample.length);
  const codeLen = Math.max(1, codeText.replace(/\s+/g, '').length);
  // simge yoğunluğu: kodda harf/rakam olmayan karakterlerin oranı (düz betikte ~%25-40)
  const symbols = (codeText.match(/[^\p{L}\p{N}\s_-]/gu) ?? []).length / codeLen;
  let score = 100 - Math.max(0, symbols - 0.38) * 140;
  const ticks = (sample.match(/[\w-]`[A-Za-z]/g) ?? []).length;
  score -= Math.min(30, (ticks / len) * 4000);
  const words = codeText.match(/\b[A-Za-z]{4,}(?:-[A-Za-z]{3,})?\b/g) ?? [];
  const random = words.filter((w) => (w.match(/[a-z][A-Z]|[A-Z]{2}[a-z]/g) ?? []).length >= 2 && !/^[A-Z][a-z]+(?:[A-Z][a-z]+)*(?:-[A-Z][a-z]+(?:[A-Z][a-z]+)*)?$/.test(w)).length;
  if (words.length) score -= Math.min(25, (random / words.length) * 60);
  // uzun base64/onaltılık bloklar ve karakter kodu listeleri (87,114,105,...)
  const blobs = [...(sample.match(/[A-Za-z0-9+/=]{80,}/g) ?? []), ...(sample.match(/(?:[0-9a-fA-F]{1,8}\s*[,;:~x|R]\s*){16,}[0-9a-fA-F]{1,8}/g) ?? [])].reduce((a, b) => a + b.length, 0);
  score -= Math.min(35, (blobs / len) * 60);
  const placeholders = (sample.match(/\{\d+\}/g) ?? []).length;
  score -= Math.min(20, (placeholders / len) * 1500);
  const concat = (sample.match(/['"][^'"\n]{1,6}['"]\s*\+/g) ?? []).length;
  score -= Math.min(20, (concat / len) * 1500);
  const lines = sample.split('\n');
  const longLines = lines.filter((l) => l.length > 240).length;
  score -= Math.min(15, (longLines / lines.length) * 40);
  if (strings / len > 0.85 && sample.length > 400) score -= 10;
  // çözücü kalıpları (iex, base64, -bxor, [char], -join/-split, -f): çözülmemiş katman izleri
  const idioms = (sample.match(/\biex\b|invoke-expression|frombase64string|-bxor|\[char\]|-join\b|-split\b|\.replace\(|\s-f\s|::create\(|-enc(?:odedcommand)?\s/gi) ?? []).length;
  score -= Math.min(30, idioms * 4);
  // ters çevrilmiş komut adları ('tuptuO-etirW')
  const reversed = (sample.match(/[A-Za-z]{2,}-[A-Za-z]{2,}/g) ?? []).filter((w) => CMD.has([...w].reverse().join('').toLowerCase()) && !CMD.has(w.toLowerCase())).length;
  score -= Math.min(25, reversed * 12);
  return clamp(score);
}
