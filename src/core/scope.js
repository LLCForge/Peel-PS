// Değişken akışı: betiğin üst düzey deyimleri sırayla gezilir ve sabit değerli değişkenler izlenir. Her değişken okuması
// (Var düğümü) için o noktadaki değer kaydedilir; katlama, ad çözme ve katman açma bu değerleri kullanır.
//   - Üst düzeydeki okuma: akışa duyarlı (yeniden atama, += ve [Array]::Reverse izlenir)
//   - İç bloktaki (işlev, döngü, betik bloğu) okuma: değişken betikte tek kez, üst düzeyde atanmışsa ve atama okumadan önce geliyorsa
//   - Hiç atanmayan otomatik değişkenler ($ShellId, $PSHome, $env:ComSpec ...): Windows PowerShell 5.1 değerleri
// Ad dolaylı yazılıyorsa (Set-Variable $ad) ya da $OFS değişiyorsa analiz kapanır (opaque). Çözülemeyen iex / nokta ile
// kaynak gösterme sonrasında üst düzey değerler bilinmez sayılır, iç bloklarda hiç değer kullanılmaz.
import { walk } from './ps.js';
import { createEvaluator, AUTOMATIC, resolveAlias, typeKey } from './eval.js';
import { Obj, isObj, Nope, toStr } from './values.js';

const UNKNOWN = Symbol('bilinmiyor');
// değeri asla sabit sayılmayan değişkenler
const SPECIAL = new Set(['_', 'psitem', 'args', 'input', 'this', 'matches', 'lastexitcode', '?', '$', '^', 'error', 'foreach', 'switch', 'sender',
  'eventargs', 'event', 'eventsubscriber', 'myinvocation', 'psboundparameters', 'pscmdlet', 'pscommandpath', 'psscriptroot', 'stacktrace', 'pwd',
  'host', 'executioncontext', 'home', 'pid', 'profile', 'true', 'false', 'null', 'psversiontable', 'psitem', 'ofs']);
const NESTING = new Set(['ScriptBlock', 'Block', 'Function', 'NamedBlock', 'While', 'DoLoop', 'For', 'Foreach', 'Switch', 'Try', 'Trap', 'If']);
const VAR_PARAM = /^(?:outv|ov$|errorv|ev$|warningv|wv$|informationv|iv$|pipelinev|pv$)/i;
const SETTERS = new Set(['set-variable', 'new-variable', 'clear-variable', 'remove-variable']);
const ITEM_SETTERS = new Set(['set-item', 'new-item', 'remove-item', 'clear-item', 'rename-item']);
const SETTER_PARAMS = ['name', 'value', 'scope', 'option', 'description', 'visibility', 'include', 'exclude'];
const ITEM_PARAMS = ['path', 'literalpath', 'value', 'name', 'itemtype', 'type', 'credential', 'filter', 'include', 'exclude', 'newname'];
const GETVAR_PARAMS = ['name', 'scope', 'include', 'exclude'];
const MUTABLE = (v) => Array.isArray(v) || v instanceof Uint8Array || (v instanceof Obj && !['type', 'enum', 'encoding', 'match', 'command', 'scriptblock'].includes(v.kind));

export const commandName = (cmd) => (cmd.type === 'Command' && !cmd.invoke && cmd.name.type === 'Bareword' && !cmd.name.complex ? resolveAlias(cmd.name.value) : null);

/**
 * Komutun konumsal ve adlı argümanları. valueParams: değer alan parametrelerin tam adları (önek eşleşir); bunlar sonraki
 * argümanı değer olarak tüketir, diğerleri anahtar (switch) sayılır.
 * @returns {{ positional: object[], named: Array<{ name, node, value }> }}
 */
export function commandArgs(cmd, valueParams = []) {
  const positional = [];
  const named = [];
  for (let i = 0; i < cmd.args.length; i++) {
    const a = cmd.args[i];
    if (a.type === 'Param') {
      const name = a.name.toLowerCase();
      if (a.value) { named.push({ name, node: a, value: a.value }); continue; }
      const takes = name && valueParams.some((p) => p.startsWith(name));
      const next = cmd.args[i + 1];
      if (takes && next && next.type !== 'Param') { named.push({ name, node: a, value: next }); i++; continue; }
      named.push({ name, node: a, value: null });
      continue;
    }
    if (a.type === 'Redirect') continue;
    positional.push(a);
  }
  return { positional, named };
}

/** Sabit dizge değeri (Str, Bareword) ya da null */
export const constText = (n) => (n && n.type === 'Str' && n.value !== null ? n.value : n && n.type === 'Bareword' && !n.complex ? n.value : null);

/**
 * @param {object} ast
 * @param {object} budget
 * @returns {{ valueOf, evaluator, assignInfo: Map, reads: Map<string, number>, opaque: boolean, dynamicExec: boolean, functions: Set }}
 */
export function analyzeScope(ast, budget, code) {
  const nested = new WeakMap();
  const targets = new WeakSet();
  const assigns = new Map(); // anahtar → { count, nested }
  const unstable = new Set();
  const reads = new Map();
  const functions = new Set();
  const mutatedNested = new Set();
  let opaque = false;
  let dynamicExec = false;
  const bump = (key, isNested) => {
    const a = assigns.get(key) ?? { count: 0, nested: 0 };
    a.count++;
    if (isNested) a.nested++;
    assigns.set(key, a);
  };
  const markTargets = (t, isNested) => {
    if (t.type === 'Var') { targets.add(t); bump(t.key, isNested); return; }
    if (t.type === 'Cast' && t.operand.type === 'Var') { targets.add(t.operand); bump(t.operand.key, isNested); unstable.add(t.operand.key); return; }
    if (t.type === 'ArrayLit') { for (const x of t.items) { markTargets(x, isNested); if (x.type === 'Var') unstable.add(x.key); } return; }
    // $x[0] = ..., $x.a = ...: nesne değişir
    let base = t;
    while (base.type === 'Index' || base.type === 'Member') base = base.object;
    if (base.type === 'Var') unstable.add(base.key);
  };

  walk(ast, (n, parent) => {
    const isNested = parent ? nested.get(parent) || NESTING.has(parent.type) : false;
    nested.set(n, isNested);
    switch (n.type) {
      case 'Assign':
        markTargets(n.target, isNested);
        if (n.target.type === 'Var' && n.target.key === 'ofs') opaque = true;
        break;
      case 'Unary': case 'Postfix':
        if ((n.op === '++' || n.op === '--') && n.operand.type === 'Var') unstable.add(n.operand.key);
        break;
      case 'Foreach':
        if (n.variable?.type === 'Var') { targets.add(n.variable); unstable.add(n.variable.key); }
        break;
      case 'Cast':
        if (/^ref$/i.test(n.typeName) && n.operand.type === 'Var') unstable.add(n.operand.key);
        break;
      case 'Function':
        functions.add(n.name.toLowerCase());
        if (n.params) unstable.add('*params');
        break;
      case 'Raw':
        if (n.reason === 'param' || n.reason === 'parametreler') unstable.add('*params');
        break;
      case 'Command': {
        for (const a of n.args) {
          if (a.type === 'Param' && VAR_PARAM.test(a.name)) {
            const v = constText(a.value);
            if (v !== null) unstable.add(v.replace(/^\+/, '').toLowerCase());
          }
        }
        if (n.invoke === '.' && n.name.type !== 'ScriptBlock') dynamicExec = true;
        const name = commandName(n);
        if (name === 'invoke-expression') dynamicExec = true;
        if (name && SETTERS.has(name)) {
          const { positional, named } = commandArgs(n, SETTER_PARAMS);
          const nm = named.find((x) => 'name'.startsWith(x.name));
          const nameNode = nm ? nm.value : positional[0];
          const v = constText(nameNode);
          if (v === null || /[*?]/.test(v)) opaque = true;
          else if (name === 'set-variable' && !isNested) bump(v.toLowerCase(), false);
          else unstable.add(v.toLowerCase());
        }
        if (name && ITEM_SETTERS.has(name)) {
          const { positional } = commandArgs(n, ITEM_PARAMS);
          const p = constText(positional[0]);
          const m = p && /^(variable|env):\\?(\w+)$/i.exec(p);
          if (m) unstable.add(m[1].toLowerCase() === 'env' ? `env:${m[2].toLowerCase()}` : m[2].toLowerCase());
          else if (p === null && positional[0]) {
            // yolu bilinmeyen öğe yazımı değişken sürücüsüne gidebilir
            const raw = positional[0];
            if (raw.type !== 'Bareword' && raw.type !== 'Str') opaque = true;
          }
        }
        break;
      }
      case 'Member':
        if (n.args !== null && n.name && /^(invokescript|newscriptblock)$/i.test(n.name)) dynamicExec = true;
        if (n.args !== null && n.object.type === 'Var' && isNested) mutatedNested.add(n.object.key);
        if (n.args !== null) for (const a of n.args) if (a.type === 'Var' && isNested) mutatedNested.add(a.key);
        break;
      case 'Var':
        if (!targets.has(n)) reads.set(n.key, (reads.get(n.key) ?? 0) + 1);
        break;
      default:
        break;
    }
    return true;
  });

  // Get-Variable / gv sabit adla okuma sayılır
  walk(ast, (n) => {
    if (n.type !== 'Command') return true;
    const name = commandName(n);
    if (name === 'get-variable' || name === 'get-item' || name === 'get-childitem') {
      const { positional, named } = commandArgs(n, name === 'get-variable' ? GETVAR_PARAMS : ITEM_PARAMS);
      const nm = named.find((x) => 'name'.startsWith(x.name) || 'path'.startsWith(x.name));
      const v = constText(nm ? nm.value : positional[0]);
      if (v === null) { if (name === 'get-variable') opaque = true; return true; }
      const m = /^(?:variable:\\?)?([\w*?]+)$/i.exec(v);
      if (!m || (name !== 'get-variable' && !/^variable:/i.test(v))) return true;
      if (/[*?]/.test(m[1])) {
        const re = new RegExp(`^${m[1].replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
        for (const k of assigns.keys()) if (re.test(k)) reads.set(k, (reads.get(k) ?? 0) + 1);
      } else reads.set(m[1].toLowerCase(), (reads.get(m[1].toLowerCase()) ?? 0) + 1);
    }
    return true;
  });

  const values = new Map();
  const assignInfo = new Map();
  // yalnızca izlenen değişkenleri değiştiren yan etkisiz deyimler (++$i, [Array]::Reverse($x), $akış.CopyTo($ms) ...)
  const pureOps = new Map();
  let env = new Map();
  const isStable = (key) => {
    const a = assigns.get(key);
    return !dynamicExec && !unstable.has(key) && a && a.count === 1 && a.nested === 0;
  };
  const known = (v) => v !== undefined && v !== UNKNOWN;
  const nameValue = (name) => {
    const key = String(name).toLowerCase();
    if (assigns.has(key)) {
      const v = env.get(key);
      return known(v) ? v : undefined;
    }
    return undefined;
  };
  const evaluator = createEvaluator({
    valueOf: (node) => values.get(node),
    nameValue,
    names: () => [...assigns.keys()].filter((k) => !k.startsWith('env:')),
    budget,
    code,
  });
  const tryValue = (node) => {
    try {
      return evaluator.eval(node);
    } catch (e) {
      if (e instanceof Nope) return UNKNOWN;
      throw e;
    }
  };

  function recordReads(stmt) {
    walk(stmt, (n) => {
      if (n.type !== 'Var' || targets.has(n)) return true;
      const key = n.key;
      if (SPECIAL.has(key)) return true;
      if (!assigns.has(key) && !unstable.has(key)) {
        const auto = AUTOMATIC[key];
        if (auto !== undefined) values.set(n, auto);
        return true;
      }
      if (opaque) return true;
      const v = env.get(key);
      if (!known(v)) return true;
      if (!nested.get(n)) values.set(n, v);
      else if (isStable(key) && !(mutatedNested.has(key) && MUTABLE(v))) values.set(n, v);
      return true;
    });
  }

  // deyimde yazılan/değiştirilen adlar
  function writtenIn(stmt) {
    const out = new Set();
    let dyn = false;
    walk(stmt, (n) => {
      if (n.type === 'Var' && targets.has(n)) out.add(n.key);
      if ((n.type === 'Unary' || n.type === 'Postfix') && (n.op === '++' || n.op === '--') && n.operand.type === 'Var') out.add(n.operand.key);
      if (n.type === 'Member' && n.args !== null) {
        if (n.object.type === 'Var') out.add(n.object.key);
        for (const a of n.args) if (a.type === 'Var') out.add(a.key);
        if (n.name && /^(invokescript|newscriptblock)$/i.test(n.name)) dyn = true;
      }
      if (n.type === 'Cast' && /^ref$/i.test(n.typeName) && n.operand.type === 'Var') out.add(n.operand.key);
      if (n.type === 'Command') {
        const name = commandName(n);
        if (name === 'invoke-expression' || (n.invoke === '.' && n.name.type !== 'ScriptBlock')) dyn = true;
        if (name && (SETTERS.has(name) || ITEM_SETTERS.has(name))) {
          const { positional, named } = commandArgs(n, SETTERS.has(name) ? SETTER_PARAMS : ITEM_PARAMS);
          const nm = named.find((x) => 'name'.startsWith(x.name) || 'path'.startsWith(x.name));
          const v = constText(nm ? nm.value : positional[0]);
          if (v) out.add(v.replace(/^variable:\\?/i, '').replace(/^env:\\?/i, 'env:').toLowerCase());
        }
        for (const a of n.args) if (a.type === 'Param' && VAR_PARAM.test(a.name)) { const v = constText(a.value); if (v) out.add(v.replace(/^\+/, '').toLowerCase()); }
      }
      if (n.type === 'Foreach' && n.variable?.type === 'Var') out.add(n.variable.key);
      return true;
    });
    return { out, dyn };
  }

  /** ++$x / $x++ / --$x / $x-- : sayısal değeri günceller; ifadenin değerini döndürür (bilinmiyorsa UNKNOWN) */
  function increment(node) {
    const op = node.op;
    const v = env.get(node.operand.key);
    if (typeof v !== 'number') { env.set(node.operand.key, UNKNOWN); return UNKNOWN; }
    const next = op === '++' ? v + 1 : v - 1;
    env.set(node.operand.key, next);
    return node.type === 'Unary' ? next : v;
  }
  const incNode = (p) => {
    const el = p?.type === 'Pipeline' && p.elements.length === 1 && !p.redirs.length ? p.elements[0] : null;
    return el && (el.type === 'Unary' || el.type === 'Postfix') && (el.op === '++' || el.op === '--') && el.operand.type === 'Var' ? el : null;
  };

  function apply(stmt) {
    // ++$i / $i++ deyimi
    const inc = incNode(stmt);
    if (inc) { increment(inc); pureOps.set(stmt, { defines: [inc.operand.key] }); return; }
    // $x = ifade
    if (stmt.type === 'Assign' && stmt.target.type === 'Var' && !SPECIAL.has(stmt.target.key)) {
      const key = stmt.target.key;
      const rhsInc = stmt.op === '=' ? incNode(stmt.value) : null;
      let v = rhsInc ? increment(rhsInc) : stmt.value.type === 'Pipeline' ? tryValue(stmt.value) : UNKNOWN;
      if (stmt.op !== '=' && known(v)) {
        const old = env.get(key);
        const op = stmt.op.slice(0, -1);
        if (!known(old) || op === '??') v = UNKNOWN;
        else {
          try { v = evaluator.binary(op, old, v); } catch (e) { if (e instanceof Nope) v = UNKNOWN; else throw e; }
        }
      }
      if (stmt.value.type === 'Pipeline' && stmt.op === '=') assignInfo.set(stmt, { key, known: known(v), defines: rhsInc ? [key, rhsInc.operand.key] : [key] });
      // atama değeri içinde başka yazımlar ($x = ($y = 1))
      const { out, dyn } = writtenIn(stmt.value);
      for (const k of out) if (!rhsInc || k !== rhsInc.operand.key) env.set(k, UNKNOWN);
      if (dyn) env = new Map([...env.keys()].map((k) => [k, UNKNOWN]));
      env.set(key, v);
      return;
    }
    if (stmt.type === 'Pipeline' && stmt.elements.length === 1) {
      const el = stmt.elements[0];
      // [Array]::Reverse($x)
      if (el.type === 'Member' && el.static && el.object.type === 'TypeLit' && typeKey(el.object.name) === 'array' && /^reverse$/i.test(el.name ?? '') && el.args?.length === 1 && el.args[0].type === 'Var') {
        const k = el.args[0].key;
        const v = env.get(k);
        env.set(k, Array.isArray(v) ? [...v].reverse() : v instanceof Uint8Array ? Uint8Array.from(v).reverse() : UNKNOWN);
        if (known(env.get(k))) pureOps.set(stmt, { defines: [k] });
        return;
      }
      // $akış.CopyTo($ms) ve $ms.Write($b, 0, $b.Length)
      if (el.type === 'Member' && !el.static && el.object.type === 'Var' && el.args && /^(copyto|write|seek|flush|close|dispose)$/i.test(el.name ?? '')) {
        const src = env.get(el.object.key);
        const nm = el.name.toLowerCase();
        if (nm === 'copyto' && el.args.length === 1 && el.args[0].type === 'Var' && known(src) && isObj(src, 'compress')) {
          try {
            env.set(el.args[0].key, evaluator.construct('io.memorystream', [evaluator.streamBytes(src)]));
            pureOps.set(stmt, { defines: [el.args[0].key] });
            return;
          } catch (e) {
            if (!(e instanceof Nope)) throw e;
          }
        } else if (nm === 'write' && el.args.length === 3 && known(src) && isObj(src, 'memorystream')) {
          const r = el.args.map(tryValue);
          if (r.every(known) && r[0] instanceof Uint8Array && r[1] === 0 && r[2] === r[0].length) {
            const merged = new Uint8Array(src.bytes.length + r[0].length);
            merged.set(src.bytes);
            merged.set(r[0], src.bytes.length);
            env.set(el.object.key, evaluator.construct('io.memorystream', [merged]));
            pureOps.set(stmt, { defines: [el.object.key] });
            return;
          }
        } else if (nm !== 'copyto' && nm !== 'write' && known(src) && (isObj(src, 'memorystream') || isObj(src, 'compress') || isObj(src, 'reader'))) {
          pureOps.set(stmt, { defines: [el.object.key] });
          return;
        }
      }
      // Set-Variable ad değer
      const name = commandName(el);
      if (name === 'set-variable') {
        const { positional, named } = commandArgs(el, ['name', 'value']);
        const extra = named.filter((x) => !'name'.startsWith(x.name) && !('value'.startsWith(x.name) && x.name.length >= 2));
        const nm = named.find((x) => 'name'.startsWith(x.name));
        const vl = named.find((x) => 'value'.startsWith(x.name) && x.name.length >= 2);
        const key = constText(nm ? nm.value : positional.shift())?.toLowerCase();
        const valueNode = vl ? vl.value : positional[0];
        if (key && !extra.length && valueNode) {
          env.set(key, tryValue(valueNode));
          return;
        }
      }
    }
    const { out, dyn } = writtenIn(stmt);
    for (const k of out) env.set(k, UNKNOWN);
    if (dyn) env = new Map([...env.keys()].map((k) => [k, UNKNOWN]));
  }

  if (!opaque) {
    for (const stmt of ast.body.stmts) {
      budget.tick();
      recordReads(stmt);
      apply(stmt);
    }
  } else {
    // yalnızca otomatik değişkenler
    walk(ast, (n) => {
      if (n.type === 'Var' && !targets.has(n) && !assigns.has(n.key) && !unstable.has(n.key) && AUTOMATIC[n.key] !== undefined) values.set(n, AUTOMATIC[n.key]);
      return true;
    });
  }

  return {
    valueOf: (node) => values.get(node),
    hasValue: (node) => values.has(node),
    evaluator,
    assignInfo,
    pureOps,
    reads,
    opaque,
    dynamicExec,
    functions,
    assigns,
    /** düğümün değeri (Nope → undefined) */
    tryEval(node) {
      const r = evaluator.tryEval(node);
      return r.ok ? r : null;
    },
    toStr,
  };
}
