// Peel-PS kütüphane API'si. Betik hiçbir zaman çalıştırılmaz; tüm değerler statik değerlendiriciden gelir.
//   import { peel, deobfuscate, analyze, createSandbox } from 'peel-ps';
// Varsayılan olarak hat çağıranın sürecinde çalışır (süre/adım bütçesiyle). Güvenilmeyen girdide yalıtım için
// createSandbox() kullanın: Node'da izin modeliyle kısıtlı alt süreç, tarayıcıda CSP'li Web Worker ve bekçi.
import { deobfuscate as runPipeline } from './core/pipeline.js';
import { analyze as runAnalyze } from './core/analyze.js';
import { PASSES } from './core/registry.js';

export async function createSandbox() {
  if (typeof process !== 'undefined' && process.versions?.node) {
    const path = './sandbox/node-host.js';
    const { createNodeSandbox } = await import(/* @vite-ignore */ path);
    return createNodeSandbox();
  }
  const path = './sandbox/web-host.js';
  const { createWebSandbox } = await import(/* @vite-ignore */ path);
  return createWebSandbox();
}

/** Girdi: betik metni ya da bayt dizisi (UTF-8; BOM'lu UTF-16LE de tanınır) */
export function toText(input) {
  if (!(input instanceof Uint8Array)) return String(input);
  if (input[0] === 0xff && input[1] === 0xfe) return new TextDecoder('utf-16le').decode(input.subarray(2));
  if (input[0] === 0xfe && input[1] === 0xff) return new TextDecoder('utf-16be').decode(input.subarray(2));
  return new TextDecoder().decode(input);
}

/** Yalnızca hat: { code, verified, partial, stats, events, trace, ms } ya da { error } */
export async function deobfuscate(input, options = {}) {
  return runPipeline(toText(input), options);
}

/**
 * Çözme + rapor. options.sandbox verilirse (createSandbox) hat yalıtılmış çalışır; günlük, geçiş ve ara adım geri
 * çağrıları iş bitince sırayla çağrılır.
 */
export async function peel(input, { sandbox, lang = 'tr', onLog = () => {}, onPass = () => {}, onSnapshot = () => {}, ...options } = {}) {
  const src = toText(input);
  if (sandbox) {
    const r = await sandbox.peel({ input: src, lang, only: options.only ?? null, formatOutput: options.formatOutput ?? true, timeoutMs: options.timeoutMs });
    for (const [m, level] of r.logs ?? []) onLog(m, level);
    for (const [id, state] of r.passes ?? []) onPass(id, state);
    for (const s of r.snapshots ?? []) onSnapshot(s);
    if (!r.ok) return { error: r.error, code: src, report: runAnalyze({ input: src, output: src, lang }) };
    return r.result;
  }
  const r = await runPipeline(src, { ...options, onLog, onPass, onSnapshot }).catch((e) => ({ error: e.message }));
  if (r.error) return { ...r, code: src, report: runAnalyze({ input: src, output: src, trace: r.trace, lang }) };
  return { ...r, report: runAnalyze({ input: src, output: r.code, trace: r.trace, events: r.events, stats: r.stats, lang }) };
}

export const analyze = runAnalyze;
export const passes = () => PASSES.map(({ id }) => ({ id }));
