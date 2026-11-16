// Sabit katlama: yan etkisiz ve statik olarak hesaplanabilen en büyük ifadeler değerleriyle değişir.
//   ("{1}{0}" -f 'ost','Write-H')            →  'Write-Host'
//   -join ('87,114' -split ',' | % {[char]$_})  →  'Wr'
//   [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('...'))  →  'çözülmüş metin'
//   [ScriptBlock]::Create('...')             →  { ... }   (içerik ayrıştırılabiliyorsa)
// Değişkenler, değişken akışının (scope.js) o noktada bildiği değerlerle okunur. Atama hedefleri, komut adları ve dinamik
// üye adları burada değil 'names' geçişinde ele alınır. Bayt dizileri ve çok büyük diziler yazılmaz.
import { walk, applyEdits, parse } from '../core/ps.js';
import { literal, isObj, Obj, PSChar } from '../core/values.js';

export const id = 'fold';

const OPERATION = new Set(['Binary', 'Unary', 'Cast', 'Member', 'Index', 'SubExpr', 'ArrayExpr', 'Pipeline', 'Var']);
const SKIP_KEYS = new Set(['target', 'variable', 'nameNode', 'name', 'typeNode']);
const OPERAND_PARENT = new Set(['Binary', 'Unary', 'Cast', 'Index', 'Member', 'Postfix']);

/** Düğüm katlanmaya değer mi: içinde en az bir işlem var ve kendisi düz değişmez değil */
function worth(node, parent) {
  switch (node.type) {
    case 'Str': return node.parts !== null;
    case 'Num': case 'Bareword': case 'TypeLit': case 'ScriptBlock': case 'Hash': return false;
    case 'Var': return false;
    case 'Unary': if (node.op === '-' && node.operand.type === 'Num') return false; break;
    case 'Paren': {
      // ('x') gibi parantezli değişmez yalnızca komut argümanında sadeleşir
      const inner = node.inner;
      if (!inner || inner.type !== 'Pipeline') return false;
      // komut argümanında tek değişmez ('x') sadeleşir; değişmez dizisi ('a', 1) olduğu gibi kalır
      if (parent?.type === 'Command' && inner.elements.length === 1 && ['Str', 'Num'].includes(inner.elements[0].type) && inner.elements[0].parts == null) return true;
      break;
    }
    case 'ArrayLit': break;
    case 'Pipeline': return false;
    default: break;
  }
  let found = false;
  walk(node, (n) => {
    if (found) return false;
    if (n !== node && OPERATION.has(n.type) && !(n.type === 'Pipeline' && n.elements.length === 1 && n.elements[0].type !== 'Command')) found = true;
    if (n.type === 'Str' && n.parts !== null) found = true;
    if (n.type === 'Cast' || n.type === 'Member' || n.type === 'Index' || n.type === 'Binary') found = true;
    if (n.type === 'Unary' && !(n.op === '-' && n.operand.type === 'Num')) found = true;
    return !found;
  });
  return found;
}

export async function run(code, ctx) {
  const scope = ctx.scope();
  const edits = [];
  walk(ctx.ast, (n, parent, key) => {
    if (SKIP_KEYS.has(key) && parent && (parent.type === 'Assign' || parent.type === 'Foreach' || parent.type === 'Member' || parent.type === 'Command' || parent.type === 'Cast')) return false;
    if (n.type === 'Command' || n.type === 'StmtList' || n.type === 'Block' || n.type === 'Script' || n.type === 'Assign' || n.type === 'Raw') return true;
    if (n.type === 'Pipeline' || n.type === 'Param' || n.type === 'Redirect' || n.type === 'If' || n.type === 'While' || n.type === 'For' || n.type === 'Foreach'
      || n.type === 'DoLoop' || n.type === 'Switch' || n.type === 'Try' || n.type === 'Function' || n.type === 'NamedBlock' || n.type === 'Flow'
      || n.type === 'Chain' || n.type === 'Trap' || n.type === 'ScriptBlock' || n.type === 'Hash' || n.type === 'Ident') return true;
    if (!worth(n, parent)) return true;
    ctx.budget.tick();
    const r = scope.tryEval(n);
    if (!r) return true;
    let v = r.value;
    let text = null;
    if (isObj(v, 'scriptblock')) {
      // yalnızca [ScriptBlock]::Create ile kurulan ve ayrıştırılabilen bloklar
      if (!v.created || v.text.length > 4_000_000) return true;
      const p = parse(v.text);
      if (p.errors) return true;
      text = `{${v.text.includes('\n') ? `\n${v.text.replace(/\s+$/, '')}\n` : v.text}}`;
    } else {
      if (isObj(v, 'type') && parent?.type === 'Command') {
        const lit = literal(v);
        text = lit ? `(${lit})` : null;
      } else {
        const charAsString = parent?.type === 'Command' || parent?.type === 'Pipeline';
        text = literal(v, { charAsString });
      }
      if (text === null) return true;
      if (v instanceof Obj && !isObj(v, 'type')) return true;
      // karakter dizileri ara biçimdir ('...'.ToCharArray()); @([char]'a', ...) okunurluğu düşürür
      if (Array.isArray(v) && v.some((x) => x instanceof PSChar)) return true;
      // çıktı patlaması: küçük bir ifadeden çok büyük değişmez üretme
      const src = n.end - n.start;
      if (text.length > Math.max(src * 20, 200_000)) return true;
      // sayıların üye/indeks nesnesi olması: (5).ToString() parantezsiz bozulur
      if ((parent?.type === 'Member' || parent?.type === 'Index') && key === 'object' && !/^'/.test(text)) text = `(${text})`;
      if (OPERAND_PARENT.has(parent?.type) && /^-/.test(text)) text = `(${text})`;
    }
    // önceki sözcüğe bitişik argüman (New-Object X('a'), Write-Host('x')): parantez korunur, yoksa sözcüğe yapışır
    if (parent?.type === 'Command' && n.start > 0 && !/\s/.test(code[n.start - 1]) && !text.startsWith('(')) text = `(${text})`;
    if (text === code.slice(n.start, n.end)) return true;
    edits.push({ start: n.start, end: n.end, text });
    return false;
  });
  if (!edits.length) return code;
  const r = applyEdits(code, edits);
  ctx.bump('fold', r.applied);
  return r.code;
}
