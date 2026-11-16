// Çözme hattı: değişiklik durana kadar geçiş turları, ardından biçimlendirme. Her geçişten sonra kod yeniden ayrıştırılır;
// geçiş yeni bir sözdizimi hatası ürettiyse (ayrıştırılamayan deyim sayısı arttıysa) dönüşüm geri alınır. Betik hiçbir
// zaman çalıştırılmaz: tüm değerler statik değerlendiriciden (eval.js) gelir. Süre/adım bütçesi aşılırsa o ana kadarki
// sonuç döner (partial).
import { PASSES } from './registry.js';
import { tryParse } from './ps.js';
import { analyzeScope } from './scope.js';
import { createBudget } from './budget.js';
import { format } from './format.js';
import { BudgetError } from './values.js';

export const MAX_ROUNDS = 64;
export const MAX_LAYERS = 256;
export const MAX_INPUT = 16 * 1024 * 1024;

/** @param {string} input PowerShell betiği (ya da powershell/cmd başlatıcı satırı) */
export async function deobfuscate(input, { only = null, onLog = () => {}, onPass = () => {}, onSnapshot = () => {}, signal = null, formatOutput = true, budget: budgetOpts } = {}) {
  const t0 = Date.now();
  const stats = {};
  const events = [];
  const layers = [];
  const log = (m, level = 'info') => onLog(m, level);
  const checkAbort = () => { if (signal?.aborted) throw new Error('Durduruldu'); };
  let code = String(input).replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (code.length > MAX_INPUT) return { error: 'Girdi çok büyük', code: input, events, stats, trace: { layers } };
  let parsed = tryParse(code);
  if (!parsed) return { error: 'Kod ayrıştırılamadı (PowerShell sözdizimi hatası)', code: input, events, stats, trace: { layers } };
  const baseErrors = parsed.errors;
  if (baseErrors) log(`${baseErrors} deyim ayrıştırılamadı; olduğu gibi korunur, içleri çözülmez`, 'warn');
  let ast = parsed.ast;
  let errors = parsed.errors;
  const budget = createBudget(budgetOpts);
  let scopeCache = null;
  const ctx = {
    ast,
    budget,
    log,
    bump: (k, n = 1) => { if (n) stats[k] = (stats[k] ?? 0) + n; },
    layer: (kind, payload, flags = []) => {
      if (layers.length >= MAX_LAYERS) throw new BudgetError(`katman sınırı aşıldı (${MAX_LAYERS})`);
      layers.push({ kind, code: payload, flags, bytes: payload.length });
    },
    scope: () => {
      if (!scopeCache || scopeCache.ast !== ctx.ast) scopeCache = { ast: ctx.ast, value: analyzeScope(ctx.ast, budget, ctx.code) };
      return scopeCache.value;
    },
    code,
  };

  let partial = false;
  const passes = PASSES.filter((p) => !only || only.includes(p.id));
  const seen = new Set([code]);
  let rounds = 0;
  outer: for (let round = 1; round <= MAX_ROUNDS; round++) {
    rounds = round;
    let changed = false;
    for (const p of passes) {
      checkAbort();
      const t = Date.now();
      onPass(p.id, 'run');
      const layersBefore = layers.length;
      const statsBefore = { ...stats };
      let next;
      try {
        ctx.ast = ast;
        ctx.code = code;
        next = await p.run(code, ctx);
      } catch (e) {
        layers.length = layersBefore;
        Object.keys(stats).forEach((k) => { if (statsBefore[k] === undefined) delete stats[k]; else stats[k] = statsBefore[k]; });
        if (e instanceof BudgetError) {
          log(`${p.id}: ${e.message}; o ana kadarki sonuç döndü`, 'warn');
          events.push({ id: p.id, round, state: 'fail', reason: 'bütçe', ms: Date.now() - t });
          onPass(p.id, 'fail');
          partial = true;
          break outer;
        }
        log(`${p.id}: ${e.message}, geri alındı`, 'warn');
        events.push({ id: p.id, round, state: 'fail', reason: e.message, ms: Date.now() - t });
        onPass(p.id, 'fail');
        continue;
      }
      checkAbort();
      if (next == null || next === code) {
        events.push({ id: p.id, round, state: 'skip', ms: Date.now() - t });
        onPass(p.id, 'skip');
        continue;
      }
      if (next.length > MAX_INPUT * 2) {
        layers.length = layersBefore;
        log(`${p.id}: çıktı çok büyük, geri alındı`, 'warn');
        events.push({ id: p.id, round, state: 'fail', reason: 'boyut', ms: Date.now() - t });
        onPass(p.id, 'fail');
        continue;
      }
      const np = tryParse(next);
      if (!np || np.errors > errors) {
        layers.length = layersBefore;
        Object.keys(stats).forEach((k) => { if (statsBefore[k] === undefined) delete stats[k]; else stats[k] = statsBefore[k]; });
        log(`${p.id}: çıktı ayrıştırılamadı, geri alındı`, 'warn');
        events.push({ id: p.id, round, state: 'fail', reason: 'ayrıştırma', ms: Date.now() - t });
        onPass(p.id, 'fail');
        continue;
      }
      code = next;
      ast = np.ast;
      errors = np.errors;
      changed = true;
      events.push({ id: p.id, round, state: 'ok', ms: Date.now() - t });
      onPass(p.id, 'ok');
      onSnapshot({ id: p.id, round, code });
    }
    if (!changed || seen.has(code)) break;
    seen.add(code);
  }

  let out = code;
  if (formatOutput) {
    try {
      const f = format(code);
      if (f !== null && f !== code) out = f;
      else if (f === null) log('format: biçimlendirilmiş çıktı doğrulanamadı, biçimlendirme atlandı', 'warn');
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      log('format: çok derin yapı, biçimlendirme atlandı', 'warn');
    }
  }
  if (layers.length) stats.layers = layers.length;
  return {
    code: out,
    stats,
    events,
    verified: baseErrors === 0,
    partial,
    trace: { layers, rounds },
    ms: Date.now() - t0,
  };
}
