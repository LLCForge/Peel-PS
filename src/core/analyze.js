// Analiz raporu. Arayüz, CLI ve kütüphane bu biçimi kullanır; alanlar eklenebilir, var olanlar değişmez.
//
// Report = {
//   detection:  [{ id, name, kind: 'obfuscator'|'packer'|'malware'|'technique', confidence (0-1), evidence: string[] }]
//   protection: null | { product, decodable: false, notes: string[] }   derlenmiş betik (PS2EXE, PE ikilisi): yalnızca tanınır
//   threat:     { score (0-100), level: 'none'|'low'|'medium'|'high'|'critical', classes: [{ id, title, evidence: string[] }] }
//   behaviour:  { network: [{ api, target }], commands: [{ api, command }], files: [{ api, path }], loads: number,
//                 other: [{ api, args }] }        çözülmüş kodda bulunan çağrılar (hiçbiri çalıştırılmadı)
//   iocs:       { urls, domains, ips, emails, discordWebhooks, telegram: string[] }
//   metrics:    { inBytes, outBytes, layers, rounds, rollbacks }
//   summary:    string
// }
// Ek alanlar: iocs.downloads (paste/raw barındırma), iocs.cradles (indirme sarmalları), iocs.amsi, iocs.persistence,
// iocs.benign (platform/belge alanları); metrics.readability { input, output } (0-100); layers [{ kind, bytes, flags }]
// (açılan katmanlar: iex, encodedcommand, command, cmd, stdin, invokescript, dot-source); lang.
// Rapor modülleri src/report/ altındadır.
import { sourcesOf } from '../report/text.js';
import { detect } from '../report/detect.js';
import { protection as findProtection } from '../report/protection.js';
import { threat as assessThreat } from '../report/threat.js';
import { iocs as findIocs } from '../report/iocs.js';
import { behaviourOf } from '../report/behaviour.js';
import { readability } from '../report/readability.js';
import { summarize } from '../report/summary.js';

/** @param {{ input: string, output: string, trace?: { layers?: object[] }, events?: object[], stats?: object, lang?: 'tr'|'en' }} o */
export function analyze({ input, output, trace = {}, events = [], stats = {}, lang = 'tr' }) {
  lang = lang === 'en' ? 'en' : 'tr';
  const layers = trace?.layers ?? [];
  const sources = sourcesOf({ input, output, trace });
  const decoded = [output, ...layers.map((l) => l.code)].filter((x) => typeof x === 'string');
  const prot = findProtection(input, lang);
  const report = {
    detection: prot ? [] : detect(sources, layers, lang),
    protection: prot,
    threat: assessThreat(prot ? [] : sources, layers, lang),
    behaviour: prot ? behaviourOf([], 0) : behaviourOf([...new Set(decoded)], layers.length),
    iocs: findIocs(sources.map((s) => s.text), decoded),
    metrics: {
      inBytes: input.length,
      outBytes: output.length,
      layers: layers.length,
      rounds: Math.max(0, ...events.map((e) => e.round ?? 0)),
      rollbacks: events.filter((e) => e.state === 'fail').length,
      readability: { input: prot ? 0 : readability(input), output: prot ? 0 : readability(output) },
    },
    layers: layers.map(({ kind, bytes, flags }) => ({ kind, bytes, flags: flags ?? [] })),
    lang,
    summary: '',
  };
  report.summary = summarize(report, lang);
  return report;
}
