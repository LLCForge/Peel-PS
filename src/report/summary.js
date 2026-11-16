// Raporun tek paragraflık özeti (tr | en); yalnızca bulunan bulgulara dayanır.
import { LEVEL } from './text.js';

const list = (xs, en) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${en ? 'and' : 've'} ${xs.at(-1)}`);

export function summarize(r, lang = 'tr') {
  const en = lang === 'en';
  const parts = [];
  const pct = (c) => (en ? `${Math.round(c * 100)}%` : `%${Math.round(c * 100)}`);
  const of = (kind) => r.detection.filter((d) => d.kind === kind);

  if (r.protection) {
    const p = r.protection;
    parts.push(en
      ? `The file is ${p.product === 'PE' ? 'a Windows (PE) binary' : `compiled with ${p.product}`}; Peel-PS only unwraps PowerShell script text, so its content is not decoded.`
      : `Dosya ${p.product === 'PE' ? 'bir Windows (PE) ikilisi' : `${p.product} ile derlenmiş`}; Peel-PS yalnızca PowerShell betiği metnini açar, içeriği çözülmez.`);
  }
  if (of('obfuscator').length) parts.push(`Obfuscator: ${list(of('obfuscator').map((d) => `${d.name} (${pct(d.confidence)})`), en)}.`);
  if (of('technique').length) parts.push(en ? `Techniques: ${list(of('technique').map((d) => d.name), en)}.` : `Kullanılan teknikler: ${list(of('technique').map((d) => d.name), en)}.`);
  const m = r.metrics;
  if (m.layers) {
    parts.push(en
      ? `${m.layers} code layer(s) (iex / -EncodedCommand / cmd) were unwrapped and the code went from ${m.inBytes} to ${m.outBytes} bytes; readability ${m.readability.input} → ${m.readability.output}/100.`
      : `${m.layers} kod katmanı (iex / -EncodedCommand / cmd) açıldı ve kod ${m.inBytes} bayttan ${m.outBytes} bayta indi; okunabilirlik ${m.readability.input} → ${m.readability.output}/100.`);
  } else if (m.readability.output !== m.readability.input) {
    parts.push(en ? `Readability ${m.readability.input} → ${m.readability.output}/100.` : `Okunabilirlik ${m.readability.input} → ${m.readability.output}/100.`);
  }
  const th = r.threat;
  const lv = LEVEL[en ? 'en' : 'tr'][th.level];
  if (th.classes.length) {
    const cls = th.classes.slice(0, 5).map((c) => c.title);
    parts.push(en ? `Threat level ${lv} (${th.score}/100): ${list(cls, en)}.` : `Tehdit düzeyi ${lv} (${th.score}/100): ${list(cls, en)}.`);
  } else if (r.protection) {
    parts.push(en ? 'Since the content is not decoded, its behaviour could not be assessed.' : 'İçerik çözülmediğinden davranışı değerlendirilemedi.');
  } else {
    parts.push(en ? 'No dangerous behaviour was found in the decoded code (threat level none).' : 'Çözülmüş kodda tehlikeli bir davranış bulunmadı (tehdit düzeyi yok).');
  }
  const b = r.behaviour;
  if (b.network.length + b.commands.length + b.files.length) {
    parts.push(en
      ? `The decoded code contains ${b.network.length} network, ${b.commands.length} command and ${b.files.length} file call(s); none were executed.`
      : `Çözülmüş kodda ${b.network.length} ağ, ${b.commands.length} komut ve ${b.files.length} dosya çağrısı var; hiçbiri çalıştırılmadı.`);
  }
  const io = r.iocs;
  const counts = [
    [io.urls, 'URL', 'URL(s)'], [io.domains, 'alan adı', 'domain(s)'], [io.ips, 'IP', 'IP(s)'], [io.emails, 'e-posta', 'e-mail(s)'],
    [io.discordWebhooks, 'Discord webhook', 'Discord webhook(s)'], [io.telegram, 'Telegram', 'Telegram'], [io.cradles, 'indirme sarmalı', 'download cradle(s)'],
    [io.amsi, 'AMSI atlatma', 'AMSI bypass(es)'], [io.persistence, 'kalıcılık izi', 'persistence trace(s)'],
  ].filter(([xs]) => xs?.length).map(([xs, tr, e]) => `${xs.length} ${en ? e : tr}`);
  if (counts.length) parts.push(en ? `IOCs: ${list(counts, en)}.` : `IOC: ${list(counts, en)}.`);
  return parts.join(' ');
}
