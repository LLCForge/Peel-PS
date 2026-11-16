// Yalıtılmış alt süreç: node --permission ile başlatılır (ağ, alt süreç, worker, dosya yazma kapalı; okuma yalnızca src ve
// node_modules). Hat betiği zaten çalıştırmaz (statik değerlendirici); izin modeli bunu işletim sistemi düzeyinde de
// garanti eder ve bekçi kilitlenmeyi süreçle birlikte keser.
import { runPeel } from './engine.js';

process.on('message', async ({ id, ...msg }) => {
  let result;
  try {
    if (msg.type !== 'peel') throw new Error(`bilinmeyen ileti: ${msg.type}`);
    result = await runPeel(msg);
  } catch (err) {
    result = { ok: false, error: String(err?.message ?? err).split('\n').slice(0, 3).join(' | '), logs: [], passes: [], snapshots: [] };
  }
  process.send({ id, ...result });
});
process.send({ ready: true });
