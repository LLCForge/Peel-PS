// Yalıtılmış çözme işi: tüm hat (ayrıştırma, statik değerlendirme, geçişler, rapor) tek iletiyle çalışır; günlük, geçiş
// durumları ve ara adımlar toplanıp sonuçla birlikte döner (çağıran bunları arayüzde yeniden oynatır). Web Worker'da
// (web-worker.js) ve Node alt sürecinde (node-proc.js) aynı kod çalışır.
import { deobfuscate } from '../core/pipeline.js';
import { analyze } from '../core/analyze.js';

// ara adımların toplam boyutu sınırlıdır: çok katmanlı büyük girdilerde ilk ve son adımlar korunur
const MAX_SNAPSHOT_BYTES = 48 * 1024 * 1024;

export async function runPeel({ input, lang = 'tr', only = null, formatOutput = true, budgetMs }) {
  const logs = [];
  const passes = [];
  const snapshots = [];
  let size = 0;
  const src = String(input ?? '');
  const res = await deobfuscate(src, {
    only,
    formatOutput,
    budget: budgetMs ? { ms: budgetMs } : undefined,
    onLog: (m, level) => logs.push([m, level]),
    onPass: (id, state) => passes.push([id, state]),
    onSnapshot: (s) => {
      size += s.code.length;
      if (size > MAX_SNAPSHOT_BYTES && snapshots.length > 1) {
        const dropped = snapshots.splice(1, 1)[0];
        size -= dropped.code.length;
      }
      snapshots.push({ id: s.id, round: s.round, code: s.code });
    },
  });
  const output = res.error ? src : res.code;
  const report = analyze({ input: src, output, trace: res.trace, events: res.events, stats: res.stats, lang });
  return { ok: true, result: { ...res, code: output, report }, logs, passes, snapshots };
}
