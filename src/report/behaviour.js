// Davranış: çözülmüş koddaki (çıktı ve açılan katmanlar) ağ, komut, dosya ve bellek içi yükleme çağrıları sözdizimi
// ağacından çıkarılır. Hiçbiri çalıştırılmaz; Peel-PS betiği yalnızca statik olarak okur.
import { parse, walk } from '../core/ps.js';
import { commandName, analyzeScope } from '../core/scope.js';
import { createBudget } from '../core/budget.js';
import { snippet } from './text.js';

const NETWORK_CMD = new Set(['invoke-webrequest', 'invoke-restmethod', 'start-bitstransfer', 'test-netconnection', 'send-mailmessage']);
const PROCESS_CMD = new Set(['start-process', 'invoke-wmimethod', 'invoke-cimmethod', 'invoke-command', 'start-job', 'new-service', 'register-scheduledtask',
  'set-mppreference', 'add-mppreference', 'stop-process', 'set-itemproperty', 'new-itemproperty', 'stop-service', 'set-executionpolicy', 'invoke-item',
  'clear-eventlog', 'set-service', 'remove-wmiobject']);
const FILE_CMD = new Set(['out-file', 'set-content', 'add-content', 'new-item', 'remove-item', 'copy-item', 'move-item', 'expand-archive', 'compress-archive', 'rename-item']);
const OTHER_CMD = new Set(['add-type', 'import-module']);
const EXTERNAL = /^(?:.*[\\/])?(?:cmd|powershell|pwsh|schtasks|reg|net|net1|wmic|certutil|bitsadmin|vssadmin|bcdedit|wevtutil|rundll32|regsvr32|mshta|cscript|wscript|sc|netsh|whoami|systeminfo|ipconfig|taskkill|attrib|icacls)(?:\.exe)?$/i;
const NET_METHODS = /^(?:downloadstring|downloadfile|downloaddata|openread|uploadstring|uploadfile|uploaddata|uploadvalues|getresponse|sendasync|getasync|getstringasync)$/i;
const FILE_METHODS = /^(?:writeallbytes|writealltext|writealllines|appendalltext|copy|delete|move)$/i;
const LOAD_METHODS = /^(?:load|loadfile|loadfrom)$/i;
const URL = /\b(?:https?|ftp):\/\/[^\s'"<>()\\{}|^`]+/i;

/** @param {string[]} texts çözülmüş kod parçaları */
export function behaviourOf(texts, layerCount = 0) {
  const b = { network: [], commands: [], files: [], loads: layerCount, other: [] };
  const seen = new Set();
  const push = (list, item) => {
    const key = `${list}\u0001${JSON.stringify(item)}`;
    if (seen.has(key) || b[list].length >= 200) return;
    seen.add(key);
    b[list].push(item);
  };
  for (const code of texts) {
    if (!code || code.length > 8_000_000) continue;
    const { ast } = parse(code);
    // argümanlardaki sabit değişkenler ($u = 'https://...') değerleriyle gösterilir
    let scope = null;
    try { scope = analyzeScope(ast, createBudget({ ms: 2000, steps: 2_000_000 }), code); } catch { scope = null; }
    const argText = (a) => {
      const r = scope?.tryEval(a);
      return r && typeof r.value === 'string' ? r.value : code.slice(a.start, a.end);
    };
    walk(ast, (n) => {
      if (n.type === 'Command') {
        const text = snippet(code.slice(n.start, n.end), 200);
        const name = commandName(n) ?? (n.name.type === 'Bareword' ? n.name.value.toLowerCase() : null);
        if (!name) return true;
        const label = n.name.type === 'Bareword' ? n.name.value : name;
        if (NETWORK_CMD.has(name)) push('network', { api: label, target: text.match(URL)?.[0] ?? snippet(code.slice(n.name.end, n.end), 120) });
        else if (PROCESS_CMD.has(name) || EXTERNAL.test(name)) push('commands', { api: label, command: text });
        else if (FILE_CMD.has(name)) {
          const arg = n.args.find((a) => a.type !== 'Param') ?? n.args.find((a) => a.type === 'Param' && /^(?:path|filepath|literalpath|destination)$/i.test(a.name));
          push('files', { api: label, path: arg ? snippet(code.slice(arg.start, arg.end), 160) : '' });
        } else if (OTHER_CMD.has(name)) push('other', { api: label, args: [snippet(code.slice(n.name.end, n.end), 160)] });
        return true;
      }
      if (n.type === 'Member' && n.args !== null && n.name) {
        const text = code.slice(n.start, n.end);
        if (NET_METHODS.test(n.name)) push('network', { api: n.name, target: text.match(URL)?.[0] ?? snippet(n.args.map(argText).join(', '), 120) });
        else if (FILE_METHODS.test(n.name) && /io\.file\]/i.test(code.slice(n.object.start, n.object.end))) push('files', { api: `[IO.File]::${n.name}`, path: snippet(n.args[0] ? code.slice(n.args[0].start, n.args[0].end) : '', 160) });
        else if (LOAD_METHODS.test(n.name) && /reflection\.assembly\]/i.test(code.slice(n.object.start, n.object.end))) push('other', { api: `[Reflection.Assembly]::${n.name}`, args: [snippet(text, 120)] });
        else if (/^start$/i.test(n.name) && /diagnostics\.process\]/i.test(code.slice(n.object.start, n.object.end))) push('commands', { api: '[Diagnostics.Process]::Start', command: snippet(text, 200) });
        else if (/^connect$/i.test(n.name)) push('network', { api: 'Connect', target: snippet(n.args.map((a) => code.slice(a.start, a.end)).join(', '), 120) });
      }
      return true;
    });
    // New-Object Net.Sockets.TCPClient('host', port)
    for (const m of code.matchAll(/net\.sockets\.tcpclient\s*\)?\s*\(?\s*['"]([^'"\n]+)['"]\s*,\s*(\d{1,5})/gi)) push('network', { api: 'Net.Sockets.TCPClient', target: `${m[1]}:${m[2]}` });
  }
  return b;
}
