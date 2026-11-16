// Çözme bütçesi: süre ve adım sınırı. Değerlendirici her düğümde, geçişler döngülerinde tick() çağırır; sınır aşılınca
// BudgetError fırlar ve hat o ana kadarki sonucu döndürür. Ayrı süreçteki/worker'daki bekçi bunun da ötesindeki
// kilitlenmeleri (ör. felaket düzenli ifade) keser.
import { BudgetError } from './values.js';

export const DEFAULT_BUDGET = { ms: 20_000, steps: 50_000_000 };

export function createBudget({ ms = DEFAULT_BUDGET.ms, steps = DEFAULT_BUDGET.steps } = {}) {
  const deadline = Date.now() + ms;
  let n = 0;
  return {
    tick(k = 1) {
      n += k;
      if (n > steps) throw new BudgetError(`adım bütçesi aşıldı (${steps})`);
      if ((n & 4095) < k && Date.now() > deadline) throw new BudgetError(`süre bütçesi aşıldı (${ms} ms)`);
    },
    get steps() { return n; },
    get expired() { return Date.now() > deadline || n > steps; },
  };
}
