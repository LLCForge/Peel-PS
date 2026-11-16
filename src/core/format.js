// Çıktı biçimlendirme: bilinen komut, parametre, tür, üye ve otomatik değişken adlarının kanonik yazımı; işleç ve anahtar
// sözcüklerin küçük harfe çekilmesi; betik değişkenlerinin ilk görüldüğü yazıma uyması (rastgele büyük/küçük harf
// gizlemesi); ; ile ayrılmış deyimlerin satırlara bölünmesi, çok deyimli blokların açılması, girinti ve boşlukların
// düzenlenmesi. Sonuç, biçim dışı her şeyin (dizgeler, yorumlar, küçük harfli kod) aynı kaldığı imzayla doğrulanır.
import { parse, walk, applyEdits } from './ps.js';
import { segments, signature } from './lex.js';
import { COMMANDS, ALIASES } from './known.js';

const CMD_CASE = new Map(COMMANDS.map((c) => [c.toLowerCase(), c]));
const ALIAS_CASE = new Map(Object.keys(ALIASES).map((a) => [a.toLowerCase(), a]));
const canonMap = (list) => new Map(list.map((x) => [x.toLowerCase(), x]));

const TYPE_CASE = canonMap(['string', 'char', 'int', 'long', 'byte', 'bool', 'double', 'object', 'void', 'array', 'type', 'regex', 'scriptblock', 'hashtable',
  'psobject', 'pscustomobject', 'xml', 'ref', 'uri', 'wmiclass', 'adsi', 'char[]', 'byte[]', 'string[]', 'int[]', 'object[]', 'int32', 'int16', 'int64',
  'Convert', 'Text.Encoding', 'Net.WebClient', 'IO.MemoryStream', 'IO.StreamReader', 'IO.StreamWriter', 'IO.Compression.DeflateStream',
  'IO.Compression.GZipStream', 'IO.Compression.CompressionMode', 'IO.File', 'IO.Path', 'IO.Directory', 'Runtime.InteropServices.Marshal',
  'Reflection.Assembly', 'Net.Sockets.TCPClient', 'Net.Sockets.UdpClient', 'Net.ServicePointManager', 'Net.SecurityProtocolType',
  'Net.WebRequest', 'Net.HttpWebRequest', 'Net.Http.HttpClient', 'Net.CredentialCache', 'Net.Dns', 'Diagnostics.Process',
  'Diagnostics.ProcessStartInfo', 'Management.Automation.PSCredential', 'Management.Automation.ScriptBlock', 'Security.SecureString',
  'Environment', 'Math', 'Text.UTF8Encoding', 'Text.ASCIIEncoding', 'Text.UnicodeEncoding', 'Security.Cryptography.AesManaged',
  'Security.Cryptography.CryptoStream', 'Security.Cryptography.CryptoStreamMode', 'Windows.Forms.Clipboard', 'Activator', 'AppDomain',
  'Management.Automation.AmsiUtils', 'Ref', 'Text.RegularExpressions.Regex', 'BitConverter', 'Guid', 'DateTime']);
const MEMBER_CASE = canonMap(['DownloadString', 'DownloadFile', 'DownloadData', 'UploadString', 'UploadFile', 'UploadData', 'OpenRead', 'Headers',
  'Proxy', 'Credentials', 'UseDefaultCredentials', 'DefaultNetworkCredentials', 'GetString', 'GetBytes', 'FromBase64String', 'ToBase64String',
  'ReadToEnd', 'ToArray', 'Replace', 'Split', 'Substring', 'ToCharArray', 'Length', 'Count', 'ToString', 'Invoke', 'Create', 'GetValue',
  'SetValue', 'InvokeScript', 'InvokeCommand', 'NewScriptBlock', 'SessionState', 'PSVariable', 'UTF8', 'ASCII', 'Unicode', 'Default',
  'Decompress', 'Compress', 'Join', 'Concat', 'Format', 'Matches', 'Value', 'Name', 'Trim', 'TrimStart', 'TrimEnd', 'ToLower', 'ToUpper',
  'Insert', 'Remove', 'Reverse', 'Load', 'GetType', 'GetMethod', 'GetField', 'GetNetworkCredential', 'Password', 'UserName',
  'SecureStringToBSTR', 'PtrToStringAuto', 'PtrToStringBSTR', 'PtrToStringUni', 'ZeroFreeBSTR', 'Write', 'Read', 'CopyTo', 'Close',
  'Dispose', 'Flush', 'Connect', 'GetStream', 'Start', 'Exit', 'ToInt16', 'ToInt32', 'ToByte', 'ToChar', 'GetEncoding', 'WriteAllBytes',
  'WriteAllText', 'ReadAllBytes', 'ReadAllText', 'GetTempPath', 'GetEnvironmentVariable', 'SetEnvironmentVariable', 'SecurityProtocol',
  'Tls12', 'NonPublic', 'Static', 'EntryPoint', 'GetFolderPath', 'Contains', 'IndexOf', 'StartsWith', 'EndsWith', 'PadLeft', 'PadRight']);
const PARAM_CASE = canonMap(['NoProfile', 'WindowStyle', 'ExecutionPolicy', 'EncodedCommand', 'Command', 'NonInteractive', 'Uri', 'OutFile',
  'UseBasicParsing', 'Method', 'Body', 'Headers', 'ArgumentList', 'FilePath', 'Verb', 'Wait', 'PassThru', 'TypeName', 'Name', 'Value', 'Path',
  'Force', 'Recurse', 'ErrorAction', 'Key', 'AsPlainText', 'ScriptBlock', 'Source', 'Destination', 'ComObject', 'Encoding', 'Scope', 'ValueOnly',
  'InputObject', 'Process', 'MemberName', 'Filter', 'Include', 'Exclude', 'NoNewWindow', 'WorkingDirectory', 'Credential', 'ComputerName',
  'Class', 'Namespace', 'Action', 'Trigger', 'TaskName', 'Description', 'Execute', 'Argument', 'User', 'RunLevel', 'DisableRealtimeMonitoring',
  'ExclusionPath', 'ExclusionProcess', 'ItemType', 'PropertyType', 'Property', 'Hidden', 'Object', 'NoNewline', 'ForegroundColor', 'Delimiter',
  'LiteralPath', 'Raw', 'Stream', 'Confirm', 'ContentType', 'UserAgent', 'Proxy', 'TimeoutSec', 'Port', 'ErrorVariable', 'OutVariable']);
const VAR_CASE = canonMap(['true', 'false', 'null', 'ShellId', 'PSHome', 'ExecutionContext', 'VerbosePreference', 'ErrorActionPreference', 'Host',
  'PSVersionTable', 'args', 'input', '_', 'PSItem', 'MyInvocation', 'PSScriptRoot', 'PSCommandPath', 'Matches', 'Error', 'HOME', 'PID', 'PWD',
  'DebugPreference', 'ProgressPreference', 'WarningPreference', 'ConfirmPreference', 'MaximumDriveCount', 'LASTEXITCODE', 'PROFILE', 'this']);
const ENV_CASE = canonMap(['ComSpec', 'Public', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME',
  'ProgramData', 'ProgramFiles', 'SystemRoot', 'windir', 'Path', 'PSModulePath', 'PROCESSOR_ARCHITECTURE', 'SystemDrive', 'HOMEPATH']);
const KEYWORD_NODE = { If: 'if', While: 'while', For: 'for', Foreach: 'foreach', Switch: 'switch', Try: 'try', Function: null, Trap: 'trap', DoLoop: 'do', NamedBlock: null, Flow: null };

function typeCase(name) {
  const sys = /^system\./i.test(name);
  const rest = sys ? name.slice(7) : name;
  const c = TYPE_CASE.get(rest.toLowerCase());
  if (!c) return null;
  return sys ? `System.${c}` : c;
}

/** Büyük/küçük harf düzenlemeleri */
function caseEdits(code, ast) {
  const edits = [];
  const set = (start, end, text) => { if (code.slice(start, end) !== text && code.slice(start, end).toLowerCase() === text.toLowerCase()) edits.push({ start, end, text }); };
  const word = (start, w) => set(start, start + w.length, w);
  const gapWord = (from, to, re) => {
    const gap = code.slice(from, to);
    if (gap.includes('#')) return;
    for (const m of gap.matchAll(re)) set(from + m.index, from + m.index + m[0].length, m[0].toLowerCase());
  };
  const firstName = new Map();
  walk(ast, (n) => {
    switch (n.type) {
      case 'Command': {
        const name = n.name;
        if (!n.invoke && name.type === 'Bareword' && !name.complex && name.raw === name.value) {
          const lower = name.value.toLowerCase();
          const c = CMD_CASE.get(lower) ?? ALIAS_CASE.get(lower);
          if (c) set(name.start, name.end, c);
        }
        for (const a of n.args) {
          if (a.type !== 'Param' || code.slice(a.start + 1, a.start + 1 + a.name.length) !== a.name) continue;
          const c = PARAM_CASE.get(a.name.toLowerCase());
          if (c) set(a.start + 1, a.start + 1 + a.name.length, c);
        }
        break;
      }
      case 'Binary':
        if (n.op.startsWith('-') && n.op.length > 1) gapWord(n.left.end, n.right.start, /-[A-Za-z]+/g);
        break;
      case 'Unary':
        if (/^-[a-z]/.test(n.op)) set(n.start, n.start + n.op.length, n.op);
        break;
      case 'TypeLit': {
        const inner = code.slice(n.start + 1, n.end - 1);
        const c = typeCase(inner.trim());
        if (c && inner === inner.trim()) set(n.start + 1, n.end - 1, c);
        break;
      }
      case 'Cast': {
        const t = n.typeNode;
        const inner = code.slice(t.start + 1, t.end - 1);
        const c = typeCase(inner.trim());
        if (c && inner === inner.trim()) set(t.start + 1, t.end - 1, c);
        break;
      }
      case 'Member':
        if (n.nameNode?.type === 'Ident' && code.slice(n.nameNode.start, n.nameNode.end) === n.nameNode.value) {
          const c = MEMBER_CASE.get(n.nameNode.value.toLowerCase());
          if (c) set(n.nameNode.start, n.nameNode.end, c);
        }
        break;
      case 'Var': {
        if (n.braced || code[n.start] !== '$') break;
        const raw = code.slice(n.start + 1, n.end);
        if (n.scope === 'env') {
          const envName = ENV_CASE.get(n.name.toLowerCase()) ?? n.name;
          set(n.start + 1, n.end, `env:${envName}`);
        } else if (!n.scope && VAR_CASE.has(n.key)) {
          set(n.start + 1, n.end, VAR_CASE.get(n.key));
        } else if (!n.scope && /^\w+$/.test(raw)) {
          const first = firstName.get(n.key);
          if (first === undefined) firstName.set(n.key, raw);
          else set(n.start + 1, n.end, first);
        }
        break;
      }
      case 'If': {
        word(n.start, 'if');
        for (let i = 0; i < n.clauses.length; i++) {
          const next = n.clauses[i + 1]?.cond.start ?? n.elseBody?.start;
          if (next !== undefined) gapWord(n.clauses[i].body.end, next, /\b(?:elseif|else)\b/gi);
        }
        break;
      }
      case 'DoLoop':
        word(n.start, 'do');
        gapWord(n.body.end, n.cond.start, /\b(?:while|until)\b/gi);
        break;
      case 'Foreach':
        word(n.start, 'foreach');
        gapWord(n.variable.end, n.iterable.start, /\bin\b/gi);
        break;
      case 'Try': {
        word(n.start, 'try');
        const blocks = [n.body, ...n.catches, n.fin].filter(Boolean);
        for (let i = 0; i + 1 < blocks.length; i++) gapWord(blocks[i].end, blocks[i + 1].start, /\b(?:catch|finally)\b/gi);
        break;
      }
      case 'Function': {
        const w = /^[A-Za-z]+/.exec(code.slice(n.start, n.start + 20))?.[0];
        if (w) word(n.start, w.toLowerCase());
        break;
      }
      case 'Flow': case 'NamedBlock': {
        const w = /^[A-Za-z]+/.exec(code.slice(n.start, n.start + 20))?.[0];
        if (w) word(n.start, w.toLowerCase());
        break;
      }
      default:
        if (KEYWORD_NODE[n.type]) word(n.start, KEYWORD_NODE[n.type]);
        break;
    }
    return true;
  });
  return edits;
}

/** Ayraç eşleşmesi ve çok deyimli bloklar; dengesizse null */
function braceInfo(code, segs) {
  const pairs = new Map();
  const stack = [];
  for (const seg of segs) {
    if (seg.kind === 'hsq' || seg.kind === 'hdq') {
      const top = stack[stack.length - 1];
      if (top?.ch === '{') top.multi = true;
      continue;
    }
    if (seg.kind !== 'code') continue;
    for (let i = seg.start; i < seg.end; i++) {
      const c = code[i];
      if (c === '`') { i++; continue; }
      if (c === '{' || c === '(' || c === '[') {
        let j = i - 1;
        while (j >= 0 && /[ \t]/.test(code[j])) j--;
        const prevWord = /([A-Za-z]+)$/.exec(code.slice(Math.max(0, j - 12), j + 1))?.[1]?.toLowerCase() ?? '';
        stack.push({ ch: c, pos: i, hash: c === '{' && code[i - 1] === '@', multi: false, opener: prevWord });
      } else if (c === '}' || c === ')' || c === ']') {
        const top = stack.pop();
        if (!top || { '}': '{', ')': '(', ']': '[' }[c] !== top.ch) return null;
        pairs.set(top.pos, { close: i, multi: top.ch === '{' && top.multi && !top.hash, opener: top.opener });
        pairs.set(i, pairs.get(top.pos));
      } else if (c === ';' || c === '\n') {
        const top = stack[stack.length - 1];
        if (top?.ch === '{') top.multi = true;
      }
    }
  }
  return stack.length ? null : pairs;
}

const INDENT = '    ';

/** Satır düzeni: ; ve çok deyimli blokları satırlara böler, girintiyi ayraç derinliğinden yeniden kurar */
export function layout(code) {
  const segs = segments(code);
  const pairs = braceInfo(code, segs);
  if (!pairs) return null;
  let out = '';
  let indent = 0;
  let lineStart = true;
  let cont = false; // önceki satır | ya da ` ile bitti
  const opens = []; // { ch, multi, line: satır numarası }
  let line = 0;
  const trimEnd = () => { out = out.replace(/[ \t]+$/, ''); };
  const newline = () => {
    trimEnd();
    const last = out.at(-1);
    cont = last === '|' || last === '`';
    out += '\n';
    line++;
    lineStart = true;
  };
  const indentNow = () => {
    if (!lineStart) return;
    const parenCont = opens.some((o) => o.ch !== '{' && o.line < line) ? 1 : 0;
    out += INDENT.repeat(Math.max(0, indent + parenCont + (cont ? 1 : 0)));
    lineStart = false;
  };
  const skipBlank = (seg, i) => {
    while (i < seg.end && /[\s;]/.test(code[i])) i++;
    return i;
  };
  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si];
    if (seg.kind !== 'code') {
      indentNow();
      out += code.slice(seg.start, seg.end).replace(/\r\n/g, '\n');
      line += (code.slice(seg.start, seg.end).match(/\n/g) ?? []).length;
      continue;
    }
    for (let i = seg.start; i < seg.end; i++) {
      const c = code[i];
      if (c === '\r') continue;
      if (c === '\n') {
        // en fazla bir boş satır
        if (lineStart && out.endsWith('\n\n')) continue;
        newline();
        continue;
      }
      if (c === ' ' || c === '\t') {
        if (lineStart || out.endsWith(' ') || /[([]$/.test(out)) continue;
        out += ' ';
        continue;
      }
      if (c === '`') {
        indentNow();
        out += c;
        if (code[i + 1] === '\n' || code[i + 1] === '\r') continue;
        if (i + 1 < seg.end) out += code[++i];
        continue;
      }
      if (c === '{') {
        indentNow();
        // if(...){  →  if (...) {
        if (/(?:\)|(?:^|[^\w$-])(?:else|try|finally|do|begin|process|end)|(?:^|\s)(?:function|filter)\s+[\w:.-]+)$/i.test(out)) out += ' ';
        out += '{';
        const info = pairs.get(i);
        opens.push({ ch: '{', multi: info?.multi, line });
        if (info?.multi) {
          indent++;
          newline();
          i = skipBlank(seg, i + 1) - 1;
        }
        continue;
      }
      if (c === '}') {
        const info = pairs.get(i);
        opens.pop();
        if (info?.multi) {
          trimEnd();
          if (!lineStart) newline();
          indent--;
          indentNow();
          out += '}';
          // } else / } catch / } finally / do { } while
          const rest = code.slice(i + 1, seg.end);
          const m = /^[\s;]*?(?=\b(?:else|elseif|catch|finally)\b)/i.exec(rest) ?? (info.opener === 'do' ? /^\s*(?=\b(?:while|until)\b)/i.exec(rest) : null);
          if (m && !/;/.test(m[0])) {
            out += ' ';
            i += m[0].length;
          }
          continue;
        }
        indentNow();
        out += '}';
        continue;
      }
      if (c === '(' || c === '[') {
        indentNow();
        if (c === '(' && /(?:^|[^\w$.-])(?:if|elseif|while|for|foreach|switch|until|catch)$/i.test(out)) out += ' ';
        out += c;
        opens.push({ ch: c, line });
        continue;
      }
      if (c === ')' || c === ']') {
        opens.pop();
        if (!lineStart) trimEnd();
        indentNow();
        out += c;
        continue;
      }
      if (c === ';') {
        const top = opens[opens.length - 1];
        if (top && top.ch !== '{') { out += ';'; continue; }
        if (top && !top.multi) { out += ';'; continue; }
        newline();
        i = skipBlank(seg, i + 1) - 1;
        continue;
      }
      indentNow();
      out += c;
    }
  }
  return `${out.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/** Biçimlendirir; sonuç doğrulanamazsa (imza farkı, yeni ayrıştırma hatası) null */
export function format(code) {
  const before = parse(code);
  const cased = applyEdits(code, caseEdits(code, before.ast)).code;
  const laid = layout(cased) ?? `${cased.trim()}\n`;
  if (signature(laid) !== signature(code)) return null;
  const after = parse(laid);
  if (after.errors > before.errors) return null;
  return laid;
}
