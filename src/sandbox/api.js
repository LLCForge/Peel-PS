// Bekçili yalıtılmış çözücüye istemci API'si (Node ve tarayıcı ortak).
export const RUN_TIMEOUT_MS = 30_000;
// bekçi süresi hattın kendi bütçesinden uzundur: hat normalde kendisi durur, bekçi yalnızca kilitlenmede (felaket
// düzenli ifade, sonsuz döngü) devreye girer
const GRACE_MS = 10_000;

export function sandboxApi(send) {
  return {
    /** Çözme + rapor: { ok, result?, logs, passes, snapshots, error? } */
    async peel({ input, lang = 'tr', only = null, formatOutput = true, timeoutMs = RUN_TIMEOUT_MS }) {
      return send({ type: 'peel', input, lang, only, formatOutput, budgetMs: timeoutMs, deadlineMs: timeoutMs + GRACE_MS });
    },
  };
}
