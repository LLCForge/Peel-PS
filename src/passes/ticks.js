// Ters tırnak (`) temizliği: Invoke-Obfuscation TOKEN gizlemesi adların ortasına anlamsız ` koyar (W`r`iTe-H`oSt,
// "d`OWn`lOAd", ${e`Nv:x}). Kaçış anlamı taşımayan ` silinir:
//   kodda ve çift tırnakta: ` + harf/rakam/_ ; ama `0 `a `b `e `f `n `r `t `u `v kaçıştır ve kalır
//   ${sürücü:ad} değişken adlarında ({ } ` dışında): ` yol kaçışıdır; düz ${a`b} adında ` adın parçasıdır, dokunulmaz
// Satır devamı (` + satır sonu), `$ `" `' gibi kaçışlar ve tek tırnaklı dizgeler dokunulmaz.
import { applyEdits } from '../core/ps.js';
import { segments } from '../core/lex.js';

export const id = 'ticks';

const ESCAPE = new Set(['0', 'a', 'b', 'e', 'f', 'n', 'r', 't', 'u', 'v']);
const removable = (d) => d !== undefined && /[\p{L}\p{N}_]/u.test(d) && !ESCAPE.has(d);

export async function run(code, ctx) {
  const edits = [];
  for (const seg of segments(code)) {
    if (seg.kind === 'code' || seg.kind === 'dq' || seg.kind === 'hdq') {
      for (let i = seg.start; i < seg.end; i++) {
        if (code[i] !== '`') continue;
        if (removable(code[i + 1])) edits.push({ start: i, end: i + 1, text: '' });
        i++;
      }
    } else if (seg.kind === 'bvar' && code.slice(seg.start, seg.end).includes(':')) {
      // yalnızca sürücü nitelikli adlarda (${e`Nv:x}) ` yol kaçışıdır; düz ${a`b} adında ` adın parçasıdır
      for (let i = seg.start + 2; i < seg.end - 1; i++) {
        if (code[i] !== '`') continue;
        if (!'{}`'.includes(code[i + 1])) edits.push({ start: i, end: i + 1, text: '' });
        i++;
      }
    }
  }
  if (!edits.length) return code;
  ctx.bump('ticks', edits.length);
  return applyEdits(code, edits).code;
}
