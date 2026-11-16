// Kod katmanları: değişmez dizgeyi kod olarak çalıştıran siteler, dizgenin kendisiyle değişir.
//   iex 'KOD' / Invoke-Expression -Command 'KOD' / &('iex') 'KOD'    →  KOD
//   'KOD' | iex  (ya da dizge dizisi: her öğe bir satır)                →  KOD
//   $ExecutionContext.InvokeCommand.InvokeScript('KOD')               →  KOD
//   . { KOD }  (nokta ile aynı kapsamda çalışan blok)                    →  KOD
//   & ({ KOD })                                                        →  & { KOD }
// Yükü yalnızca statik olarak hesaplanabilen siteler açılır; girdiye, ağa ya da ortama bağlı yükler (iex (iwr ...))
// olduğu gibi kalır. Yük ayrıştırılamıyorsa (kod değilse) site açılmaz. Değer bağlamındaki iex ($x = iex 'Get-Date')
// tek deyimlik yükte ifadeyle, çok deyimlikte $( ) ile değişir.
import { walk, applyEdits, parse } from '../core/ps.js';
import { isObj } from '../core/values.js';
import { commandName, commandArgs } from '../core/scope.js';
import { resolveAlias } from '../core/eval.js';

export const id = 'layers';

const MAX_PAYLOAD = 16 * 1024 * 1024;

export async function run(code, ctx) {
  const scope = ctx.scope();
  const edits = [];
  let opened = 0;

  const isIex = (cmd) => {
    if (cmd.type !== 'Command' || cmd.redirs.length) return false;
    if (!cmd.invoke) return commandName(cmd) === 'invoke-expression';
    if (cmd.name.type === 'ScriptBlock') return false;
    const r = scope.tryEval(cmd.name);
    const s = r && (typeof r.value === 'string' ? r.value : isObj(r.value, 'command') ? r.value.name : null);
    return s !== null && resolveAlias(s) === 'invoke-expression';
  };
  /** Değeri koda çevirir: dizge ya da dizge dizisi (satırlar); değilse null */
  const asCode = (v) => {
    if (typeof v === 'string') return v;
    if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) return v.join('\n');
    return null;
  };
  const payloadOf = (node) => {
    const r = scope.tryEval(node);
    if (!r) return null;
    const s = asCode(r.value);
    if (s === null || s.length > MAX_PAYLOAD || !s.trim()) return null;
    if (parse(s).errors) return null;
    return s.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
  };
  const singleStatement = (s) => {
    const p = parse(s).ast.body.stmts;
    return p.length === 1 && (p[0].type === 'Pipeline' || p[0].type === 'Chain');
  };

  /** Site değişimi: deyim bağlamında kodun kendisi, değer bağlamında ifade */
  function replace(node, parent, key, payload, kind) {
    const statement = key === 'stmts';
    let text;
    if (statement) text = payload;
    else if (parent?.type === 'Assign' || parent?.type === 'Paren' || (parent?.type === 'Flow' && key === 'value')) text = singleStatement(payload) ? payload : `$(\n${payload}\n)`;
    else return false;
    edits.push({ start: node.start, end: node.end, text });
    ctx.layer(kind, payload);
    opened++;
    return true;
  }

  walk(ctx.ast, (n, parent, key) => {
    if (n.type !== 'Pipeline' || n.redirs.length || n.background) return true;
    const els = n.elements;
    const last = els[els.length - 1];
    // iex 'KOD'
    if (els.length === 1 && isIex(last)) {
      const { positional, named } = commandArgs(last, ['command']);
      let arg = null;
      if (named.length === 1 && 'command'.startsWith(named[0].name) && named[0].value && !positional.length) arg = named[0].value;
      else if (!named.length && positional.length === 1) arg = positional[0];
      const payload = arg && payloadOf(arg);
      if (payload !== null && payload !== undefined && replace(n, parent, key, payload, 'iex')) return false;
      return true;
    }
    // 'KOD' | iex
    if (els.length === 2 && isIex(last) && !last.args.length && els[0].type !== 'Command') {
      const payload = payloadOf(els[0]);
      if (payload !== null && replace(n, parent, key, payload, 'iex')) return false;
      return true;
    }
    // 'İFADE' | iex | iex ...: ilk iex'in yükü tek bir ifadeyse (karakter kodu toplamı gibi) ( İFADE ) olarak yerine yazılır
    if (els.length > 2 && els[0].type !== 'Command' && isIex(els[1]) && !els[1].args.length) {
      const payload = payloadOf(els[0]);
      if (payload !== null) {
        const st = parse(payload).ast.body.stmts;
        if (st.length === 1 && st[0].type === 'Pipeline' && st[0].elements.length === 1 && st[0].elements[0].type !== 'Command') {
          edits.push({ start: els[0].start, end: els[1].end, text: `(${payload})` });
          ctx.layer('iex', payload);
          opened++;
          return false;
        }
      }
      return true;
    }
    if (els.length === 1) {
      const el = els[0];
      // $ExecutionContext.InvokeCommand.InvokeScript('KOD')
      if (el.type === 'Member' && el.args?.length === 1 && /^invokescript$/i.test(el.name ?? '') && el.object.type === 'Member' && /^invokecommand$/i.test(el.object.name ?? '')
        && el.object.object.type === 'Var' && el.object.object.key === 'executioncontext') {
        const payload = payloadOf(el.args[0]);
        if (payload !== null && replace(n, parent, key, payload, 'invokescript')) return false;
        return true;
      }
      // . { KOD }: aynı kapsamda çalışır, olduğu gibi yerine yazılabilir ($args/param kullanılmıyorsa)
      if (el.type === 'Command' && el.invoke && !el.args.length && !el.redirs.length) {
        let block = el.name;
        while (block.type === 'Paren' && block.inner?.type === 'Pipeline' && block.inner.elements.length === 1) block = block.inner.elements[0];
        if (block.type === 'ScriptBlock') {
          const body = code.slice(block.start + 1, block.end - 1).replace(/^\s*\n/, '').replace(/\s+$/, '');
          if (el.invoke === '.' && key === 'stmts' && !/\$args\b|\$input\b|^\s*param\s*\(/im.test(body) && body.trim()) {
            edits.push({ start: n.start, end: n.end, text: body });
            ctx.layer('dot-source', body);
            opened++;
            return false;
          }
          if (block !== el.name) {
            // & ({ KOD }) → & { KOD }
            edits.push({ start: el.name.start, end: el.name.end, text: code.slice(block.start, block.end) });
            return false;
          }
        }
      }
    }
    return true;
  });
  if (!edits.length) return code;
  const r = applyEdits(code, edits);
  ctx.bump('layers', opened);
  if (opened) ctx.log(`layers: ${opened} katman açıldı`, 'info');
  return r.code;
}

