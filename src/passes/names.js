// Ad dolaylılığını çözer (Invoke-Obfuscation TOKEN\COMMAND, MEMBER, VARIABLE ve dolaylı değişken erişimi):
//   &("{1}{0}" -f 'ost','Write-H') x       →  Write-Host x
//   .('Down'+'loadString').Invoke($u)     →  .DownloadString($u)
//   ${e`Nv:ComSpec} / ${abc}               →  $env:ComSpec / $abc
//   (Get-Variable abc).Value, (gv abc -ValueOnly), (Get-Item variable:abc).Value, (gi env:x).Value  →  $abc, $env:x
//   Set-Variable abc 'v' / sv abc 'v'      →  $abc = 'v'
//   $p = @{ Uri = 'x' }; iwr @p            →  iwr -Uri 'x'   (sabit karma tablo, tek kullanım)
//   New-Object 'Net.WebClient'             →  New-Object Net.WebClient
import { walk, applyEdits, isSimpleName, isIdentifier, psQuote, parse } from '../core/ps.js';
import { literal, isObj, PSChar } from '../core/values.js';
import { commandName, commandArgs, constText } from '../core/scope.js';

export const id = 'names';

const VAR_NAME = /^(?:(env|script|global|local|private|using):)?[A-Za-z_]\w*$/i;
const varRef = (name) => (VAR_NAME.test(name) ? `$${name}` : `\${${name.replace(/[{}`]/g, (c) => `\`${c}`)}}`);
const prefixOf = (x, full, min = 1) => x.length >= min && full.startsWith(x);

export async function run(code, ctx) {
  const scope = ctx.scope();
  const edits = [];
  const skip = new WeakSet();
  const evalName = (node) => {
    if (node.type === 'Bareword' && !node.complex) return node.value;
    if (node.type === 'Str' && node.value !== null) return node.value;
    const r = scope.tryEval(node);
    if (!r) return null;
    const v = r.value;
    if (typeof v === 'string') return v;
    if (v instanceof PSChar) return String.fromCharCode(v.code);
    if (isObj(v, 'command')) return v.name;
    return null;
  };
  const edit = (start, end, text) => { if (text !== code.slice(start, end)) edits.push({ start, end, text }); };

  // (Get-Variable x).Value, (gv x -ValueOnly), (Get-Item variable:x).Value ... → $x
  function variableOf(cmd, needValueOnly) {
    const name = commandName(cmd);
    if (!['get-variable', 'get-item', 'get-childitem'].includes(name ?? '')) return null;
    const { positional, named } = commandArgs(cmd, name === 'get-variable' ? ['name'] : ['path', 'literalpath']);
    let target;
    let valueOnly = false;
    for (const x of named) {
      if (name === 'get-variable' && prefixOf(x.name, 'name') && x.value) target = x.value;
      else if (name === 'get-variable' && prefixOf(x.name, 'valueonly') && !x.value) valueOnly = true;
      else if (name !== 'get-variable' && (prefixOf(x.name, 'path') || prefixOf(x.name, 'literalpath', 2)) && x.value) target = x.value;
      else return null;
    }
    if (!target) target = positional.shift();
    if (positional.length) return null;
    const t = constText(target);
    if (t === null || /[*?[]/.test(t)) return null;
    if (name === 'get-variable') {
      if (valueOnly !== needValueOnly || !/^[\w:]+$/.test(t)) return null;
      return varRef(t);
    }
    if (needValueOnly) return null;
    const m = /^(variable|env):\\?(\w+)$/i.exec(t);
    if (!m) return null;
    return m[1].toLowerCase() === 'env' ? `$env:${m[2]}` : varRef(m[2]);
  }
  const singleCommand = (node) => (node?.type === 'Pipeline' && node.elements.length === 1 && node.elements[0].type === 'Command' && !node.redirs.length ? node.elements[0] : null);

  walk(ctx.ast, (n, parent, key) => {
    if (skip.has(n)) return false;
    switch (n.type) {
      case 'Command': {
        // & / . ile çağrılan hesaplanmış komut adı
        if (n.invoke && n.name.type !== 'ScriptBlock') {
          // & ([ScriptBlock]::Create('KOD')) → & {KOD}
          const sb = n.name.type === 'Paren' ? scope.tryEval(n.name) : null;
          if (sb && isObj(sb.value, 'scriptblock') && sb.value.created && sb.value.text.length < 4_000_000 && !parse(sb.value.text).errors) {
            edit(n.name.start, n.name.end, `{${sb.value.text}}`);
            skip.add(n.name);
            return true;
          }
          const s = evalName(n.name);
          if (s !== null && s.length < 300) {
            skip.add(n.name);
            if (isSimpleName(s) && !/[\\/]/.test(s)) {
              const keepDot = n.invoke === '.' && scope.functions.has(s.toLowerCase());
              edit(n.start, n.name.end, keepDot ? `. ${s}` : s);
            } else if (n.name.type !== 'Str') {
              edit(n.name.start, n.name.end, psQuote(s));
            }
          }
        }
        const name = commandName(n);
        // Set-Variable / sv / Set-Item variable: deyimi → atama
        if ((name === 'set-variable' || name === 'set-item') && parent?.type === 'Pipeline' && parent.elements.length === 1 && !parent.redirs.length && !n.redirs.length) {
          const { positional, named } = commandArgs(n, name === 'set-item' ? ['path', 'value'] : ['name', 'value']);
          let nameNode;
          let valueNode;
          let ok = true;
          for (const x of named) {
            if (prefixOf(x.name, name === 'set-item' ? 'path' : 'name') && x.value) nameNode = x.value;
            else if (prefixOf(x.name, 'value', 2) && x.value) valueNode = x.value;
            else ok = false;
          }
          if (!nameNode) nameNode = positional.shift();
          if (!valueNode) valueNode = positional.shift();
          let target = constText(nameNode);
          if (name === 'set-item') {
            const m = target && /^(variable|env):\\?(\w+)$/i.exec(target);
            target = m ? (m[1].toLowerCase() === 'env' ? `env:${m[2]}` : m[2]) : null;
          }
          if (ok && !positional.length && target && !/[*?]/.test(target) && valueNode && !valueNode.complex) {
            const value = valueNode.type === 'Bareword' ? psQuote(valueNode.value) : valueNode.type === 'ArrayLit' ? null : code.slice(valueNode.start, valueNode.end);
            if (value !== null) {
              edit(parent.start, parent.end, `${target.startsWith('env:') ? `$${target}` : varRef(target)} = ${value}`);
              return false;
            }
          }
        }
        // statement: Get-Variable x -ValueOnly
        if (parent?.type === 'Pipeline' && parent.elements.length === 1) {
          const v = variableOf(n, true);
          if (v) { edit(n.start, n.end, v); return false; }
        }
        // New-Object 'Net.WebClient' → New-Object Net.WebClient
        if (name === 'new-object') {
          const first = n.args.find((a) => a.type !== 'Param');
          if (first?.type === 'Str' && first.value !== null && /^[A-Za-z_][\w.]*$/.test(first.value) && n.args.indexOf(first) === 0) edit(first.start, first.end, first.value);
        }
        // @p sıçratma: sabit karma tablo, yalnızca burada okunuyor
        for (const a of n.args) {
          if (a.type !== 'Var' || !a.splat || scope.reads.get(a.key) !== 1) continue;
          const v = scope.valueOf(a);
          if (isObj(v, 'hashtable')) {
            const parts = [];
            for (const { key: k, value } of v.map.values()) {
              const lit = literal(value);
              if (!isIdentifier(k) || lit === null) { parts.length = 0; break; }
              parts.push(typeof value === 'boolean' ? `-${k}:${lit}` : `-${k} ${lit}`);
            }
            if (parts.length === v.map.size && parts.length) edit(a.start, a.end, parts.join(' '));
          } else if (Array.isArray(v) && v.length && v.length <= 64) {
            const lits = v.map((x) => (typeof x === 'string' || typeof x === 'number' ? literal(x) : null));
            if (!lits.includes(null)) edit(a.start, a.end, lits.join(' '));
          }
        }
        return true;
      }
      case 'Member': {
        // .(hesaplanmış).Invoke(args) → .Ad(args)
        const inner = n.object;
        if (n.args !== null && /^invoke$/i.test(n.name ?? '') && inner.type === 'Member' && inner.args === null && inner.nameNode.type !== 'Ident') {
          const s = evalName(inner.nameNode);
          if (s !== null && isIdentifier(s)) {
            edit(inner.nameNode.start - (inner.static ? 2 : 1), n.nameNode.end, `${inner.static ? '::' : '.'}${s}`);
            skip.add(inner.nameNode);
            skip.add(n.nameNode);
            return true;
          }
        }
        // (Get-Variable x).Value, (Get-Item variable:x).Value
        if (n.args === null && /^value$/i.test(n.name ?? '') && inner.type === 'Paren') {
          const cmd = singleCommand(inner.inner);
          const v = cmd && variableOf(cmd, false);
          if (v) { edit(n.start, n.end, v); return false; }
        }
        // $ExecutionContext.SessionState.PSVariable.GetValue('x')
        if (n.args?.length === 1 && /^getvalue$/i.test(n.name ?? '') && inner.type === 'Member' && /^psvariable$/i.test(inner.name ?? '')
          && inner.object.type === 'Member' && /^sessionstate$/i.test(inner.object.name ?? '') && inner.object.object.type === 'Var' && inner.object.object.key === 'executioncontext') {
          const t = evalName(n.args[0]);
          if (t && /^\w+$/.test(t)) { edit(n.start, n.end, varRef(t)); return false; }
        }
        if (n.nameNode && n.nameNode.type !== 'Ident') {
          const s = evalName(n.nameNode);
          if (s !== null && isIdentifier(s)) {
            edit(n.nameNode.start, n.nameNode.end, s);
            skip.add(n.nameNode);
          }
        }
        return true;
      }
      case 'Paren': {
        const cmd = singleCommand(n.inner);
        const v = cmd && variableOf(cmd, true);
        if (v) { edit(n.start, n.end, v); return false; }
        return true;
      }
      case 'Var': {
        if (n.braced || n.scope === 'variable') {
          const full = n.scope && n.scope !== 'variable' ? `${n.scope}:${n.name}` : n.name;
          // "${a}b" ya da ${a}.txt parantezsiz başka anlama gelir
          if (VAR_NAME.test(full) && !/[\p{L}\p{N}_:.[(-]/u.test(code[n.end] ?? '')) edit(n.start, n.end, `${n.splat ? '@' : '$'}${full}`);
        }
        return true;
      }
      default:
        return true;
    }
  });
  if (!edits.length) return code;
  const r = applyEdits(code, edits);
  ctx.bump('names', r.applied);
  return r.code;
}
