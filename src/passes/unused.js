// Kullanılmayan atamalar: katman açma, katlama ve ad çözmeden sonra artık okunmayan değişkenlerin yan etkisiz
// atamaları ve yalnızca bu değişkenleri değiştiren deyimler silinir ($x = 'tsoH-etirW'; $c = ...; [Array]::Reverse($c);
// $z.CopyTo($out)). Yalnızca betiğin üst düzeyindeki, değeri statik olarak hesaplanmış (dolayısıyla yan etkisiz) deyimler
// silinir; zincirler geriye doğru çözülür ($in → $z → $out). Ad dolaylı okunabiliyorsa (çözülemeyen iex, nokta ile
// kaynak, joker Get-Variable) geçiş atlanır. $env: atamaları alt süreçler okuyabileceği için yalnızca betik süreç
// başlatmıyorsa silinir.
import { walk, applyEdits } from '../core/ps.js';
import { commandName } from '../core/scope.js';

export const id = 'unused';

const PROCESS = new Set(['start-process', 'invoke-item', 'invoke-wmimethod', 'invoke-cimmethod', 'start-job', 'invoke-command', 'start-bitstransfer']);
const EXTERNAL = /\.(?:exe|com|bat|cmd)$|^(?:powershell|pwsh|cmd|wmic|rundll32|regsvr32|mshta|cscript|wscript|schtasks|reg|certutil|bitsadmin)$/i;

function launchesProcesses(ast) {
  let found = false;
  walk(ast, (n) => {
    if (found) return false;
    if (n.type === 'Command') {
      const name = commandName(n);
      if (n.invoke || name === null || PROCESS.has(name) || EXTERNAL.test(name)) found = true;
    }
    if (n.type === 'Member' && n.args !== null && /^(start|create)$/i.test(n.name ?? '')) found = true;
    return !found;
  });
  return found;
}

/** deyimdeki okumalar (hedef olmayan değişken düğümleri) */
function readsIn(stmt) {
  const out = [];
  const target = stmt.type === 'Assign' ? stmt.target : null;
  walk(stmt, (n) => {
    if (n === target) return false;
    if (n.type === 'Var') out.push(n.key);
    return true;
  });
  return out;
}

export async function run(code, ctx) {
  const scope = ctx.scope();
  if (scope.opaque || scope.dynamicExec) return code;
  let spawns = null;
  // aday deyimler: { stmt, defines, reads }
  const candidates = [];
  for (const st of ctx.ast.body.stmts) {
    let defines = null;
    if (st.type === 'Assign' && st.op === '=' && st.target.type === 'Var') {
      const info = scope.assignInfo.get(st);
      if (!info?.known) continue;
      const key = st.target.key;
      if (key.startsWith('env:')) {
        spawns ??= launchesProcesses(ctx.ast);
        if (spawns) continue;
      } else if (st.target.scope && st.target.scope !== 'script' && st.target.scope !== 'local') continue;
      defines = info.defines;
    } else if (scope.pureOps.has(st)) defines = scope.pureOps.get(st).defines;
    if (defines) candidates.push({ stmt: st, defines, reads: readsIn(st) });
  }
  if (!candidates.length) return code;
  // okuma sayıları: tüm betik; silinen deyimin kendi okumaları düşülür
  const reads = new Map(scope.reads);
  const removed = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const c of candidates) {
      if (removed.has(c)) continue;
      const own = new Map();
      for (const k of c.reads) own.set(k, (own.get(k) ?? 0) + 1);
      if (c.defines.some((k) => (reads.get(k) ?? 0) - (own.get(k) ?? 0) > 0)) continue;
      removed.add(c);
      for (const [k, n] of own) reads.set(k, (reads.get(k) ?? 0) - n);
      changed = true;
    }
  }
  if (!removed.size) return code;
  ctx.bump('unused', removed.size);
  const edits = [...removed].map(({ stmt }) => ({ start: stmt.start, end: stmt.end, text: '' }));
  // silinen deyimin ardındaki ';' ve satır sonu da gider
  const r = applyEdits(code, edits.map((e) => ({ ...e, end: e.end + (/^[ \t]*;?[ \t]*(?:\r?\n)?/.exec(code.slice(e.end))?.[0].length ?? 0) })));
  return r.code;
}
