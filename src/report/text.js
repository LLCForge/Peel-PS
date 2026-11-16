// Rapor modüllerinin ortak yardımcıları: kaynak metinleri, kanıt kesitleri, dil seçimi, düz metin rapor.
// Tarayıcıda da çalışır (Node'a özgü API yok).

export const t = (tr, en = tr) => ({ tr, en });
export const pick = (o, lang) => (lang === 'en' ? o.en : o.tr);

/** Antivirüs imzalarına takılmasın diye şüpheli dizgeler kaynakta parçalı yazılır: rx(['Amsi', 'Utils']) */
export const rx = (parts, flags = '') => new RegExp(parts.join(''), flags);

export const WHERE = {
  input: t('girdi', 'input'),
  load: t('açılan katman', 'unwrapped layer'),
  output: t('çıktı', 'output'),
  behaviour: t('katmanlar', 'layers'),
  all: t('tüm kaynaklar', 'all sources'),
};

/** Kanıt için tek satırlık, kısaltılmış kesit */
export function snippet(s, max = 120) {
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * Analiz edilecek kaynaklar: girdi, açılan katmanlar (iex, -EncodedCommand, cmd ...) ve çözülmüş çıktı.
 * Her biri { where: 'input'|'load'|'output', text }; aynı içerik bir kez alınır.
 */
export function sourcesOf({ input = '', output = '', trace }) {
  const seen = new Set();
  const out = [];
  const add = (where, text) => {
    if (typeof text !== 'string' || !text.trim() || seen.has(text)) return;
    seen.add(text);
    out.push({ where, text });
  };
  add('input', input);
  for (const l of trace?.layers ?? []) add('load', l?.code);
  add('output', output);
  return out;
}

export const LEVEL = {
  tr: { none: 'yok', low: 'düşük', medium: 'orta', high: 'yüksek', critical: 'kritik' },
  en: { none: 'none', low: 'low', medium: 'medium', high: 'high', critical: 'critical' },
};

/** CLI için okunabilir düz metin rapor */
export function reportText(r, lang = r?.lang ?? 'tr') {
  const en = lang === 'en';
  const L = (tr, e) => (en ? e : tr);
  const pct = (c) => (en ? `${Math.round(c * 100)}%` : `%${Math.round(c * 100)}`);
  const lines = [];
  lines.push(`${L('Özet', 'Summary')}: ${r.summary}`);
  lines.push(`${L('Tehdit', 'Threat')}: ${LEVEL[en ? 'en' : 'tr'][r.threat.level]} (${r.threat.score}/100)`);
  for (const c of r.threat.classes) {
    lines.push(`  - ${c.title}`);
    for (const e of c.evidence) lines.push(`      ${e}`);
  }
  if (r.protection) {
    const p = r.protection;
    lines.push(`${L('Koruma', 'Protection')}: ${p.product}${p.version ? ` ${p.version}` : ''} (${L('çözülmez', 'not decoded')})`);
    for (const n of p.notes) lines.push(`  - ${n}`);
  }
  if (r.detection.length) {
    lines.push(`${L('Tespitler', 'Detections')}:`);
    for (const d of r.detection) {
      lines.push(`  - ${d.name} [${d.kind}] ${pct(d.confidence)}`);
      for (const e of d.evidence) lines.push(`      ${e}`);
    }
  }
  if (r.layers?.length) {
    lines.push(`${L('Açılan katmanlar', 'Unwrapped layers')}:`);
    for (const l of r.layers.slice(0, 30)) lines.push(`  - ${l.kind} (${l.bytes} ${L('bayt', 'bytes')})${l.flags?.length ? ` ${l.flags.join(' ')}` : ''}`);
    if (r.layers.length > 30) lines.push(`  … (+${r.layers.length - 30})`);
  }
  const b = r.behaviour;
  const acts = [...b.network.map((n) => `${n.api} ${n.target}`), ...b.commands.map((c) => c.command), ...b.files.map((f) => `${f.api} ${f.path}`), ...b.other.map((o) => `${o.api} ${o.args.join(' ')}`)];
  if (acts.length) {
    lines.push(`${L('Davranış (çözülmüş kodda bulunan çağrılar; hiçbiri çalıştırılmadı)', 'Behaviour (calls found in the decoded code; none were executed)')}:`);
    for (const a of acts.slice(0, 30)) lines.push(`  - ${snippet(a, 160)}`);
    if (acts.length > 30) lines.push(`  … (+${acts.length - 30})`);
  }
  const io = r.iocs;
  const keys = ['urls', 'domains', 'ips', 'emails', 'discordWebhooks', 'telegram', 'downloads', 'cradles', 'amsi', 'persistence', 'benign'];
  if (keys.some((k) => io[k]?.length)) {
    lines.push('IOC:');
    for (const k of keys) if (io[k]?.length) lines.push(`  ${k}: ${io[k].join(', ')}`);
  }
  const m = r.metrics;
  lines.push(`${L('Ölçüler', 'Metrics')}: ${m.inBytes} → ${m.outBytes} ${L('bayt', 'bytes')}, ${L('okunabilirlik', 'readability')} ${m.readability.input} → ${m.readability.output}/100, ${L('katman', 'layers')} ${m.layers}, ${L('tur', 'rounds')} ${m.rounds}, ${L('geri alma', 'rollbacks')} ${m.rollbacks}`);
  return `${lines.join('\n')}\n`;
}
