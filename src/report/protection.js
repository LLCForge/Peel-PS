// Derlenmiş PowerShell betiklerini tanıma: PS2EXE ile .exe'ye çevrilmiş betikler ve diğer PE ikilileri. Peel-PS yalnızca
// betik metnini açar; ikili içerik çözülmez (decodable: false), yalnızca dosyada açık duran izler okunur.
// Girdi metindir (UTF-8 çözülmüş): ikili baytlar U+FFFD olabilir, aranan izler ASCII'dir.
import { pick, t } from './text.js';

const COMMON = t(
  'Peel-PS yalnızca PowerShell betiği metnini açar; derlenmiş ya da paketlenmiş içerik çözülmez.',
  'Peel-PS only unwraps PowerShell script text; compiled or packed content is not decoded.',
);

/** @returns {null | { product, version, decodable: false, notes }} */
export function protection(text, lang = 'tr') {
  const s = typeof text === 'string' ? (text.length > 8_000_000 ? text.slice(0, 8_000_000) : text) : '';
  if (!s.startsWith('MZ')) return null;
  const notes = [];
  // PS2EXE: gömülü betik .NET kaynağı olarak saklanır; derleyici izleri açık metindedir
  const ps2exe = /PS2EXE|PS2EXEHost|ik\.PowerShell|PS2EXEApp/.test(s);
  if (ps2exe) {
    notes.push(pick(t('PS2EXE izleri bulundu: betik .NET ikilisine gömülü (çoğunlukla base64 ya da kaynak olarak).', 'PS2EXE traces found: the script is embedded in a .NET binary (usually as base64 or a resource).'), lang));
    notes.push(pick(t('Çalıştırmadan çıkarmak için bir .NET derleme görüntüleyicisi (ILSpy, dnSpy) ya da Peel-NET kullanın; çıkan .ps1 dosyasını Peel-PS\'e verin.', 'To extract it without running it, use a .NET assembly viewer (ILSpy, dnSpy) or Peel-NET, then feed the resulting .ps1 to Peel-PS.'), lang));
  } else {
    notes.push(pick(t('PE (Windows) ikilisi; PowerShell betiği değil ve bilinen bir betik derleyicisi izi yok.', 'PE (Windows) binary; not a PowerShell script and no known script-compiler trace.'), lang));
  }
  return { product: ps2exe ? 'PS2EXE' : 'PE', version: null, decodable: false, notes: [...notes, pick(COMMON, lang)] };
}
