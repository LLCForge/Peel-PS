// Başlatıcılar (Invoke-Obfuscation LAUNCHER ve elle yazılmış eşdeğerleri): betiği yeni bir powershell/cmd süreciyle
// çalıştıran satırlar, taşıdıkları PowerShell koduyla değişir.
//   powershell -nop -w hidden -enc <UTF-16LE base64>          →  KOD
//   powershell -NoProfile -Command "KOD" / powershell "KOD"   →  KOD
//   cmd /c "powershell ... KOD" / %COMSPEC% /b /c start /b /min powershell ...   →  KOD
//   cmd /c "set X=KOD&& powershell ... $env:X | iex"         →  $env:X = 'KOD' + KOD (iex katmanı sonra açılır)
//   cmd /c "echo KOD | powershell -"                         →  KOD
// Satır betiğin tamamıysa kod yerine yazılır; daha büyük bir betiğin içindeyse alt süreç ayrı kapsam olduğundan & { KOD }
// olur. Başlatıcı bayrakları (-w hidden, -nop, -ep bypass ...) rapora katman bilgisi olarak geçer.
import { walk, applyEdits, parse, psQuote } from '../core/ps.js';
import { base64Decode, decodeText } from '../core/codec.js';

export const id = 'launcher';

const PS_EXE = /^(?:.*[\\/])?(?:powershell|pwsh)(?:\.exe)?$/i;
const CMD_EXE = /^(?:.*[\\/])?cmd(?:\.exe)?$|^%comspec%$/i;

/** Windows komut satırı (CommandLineToArgvW kuralları): boşluk ayırır, "..." gruplar, \" ve 2n ters bölü kuralları */
export function argv(line) {
  const out = [];
  let i = 0;
  const s = String(line);
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    let arg = '';
    let quoted = false;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') {
        let n = 0;
        while (s[i + n] === '\\') n++;
        if (s[i + n] === '"') {
          arg += '\\'.repeat(Math.floor(n / 2));
          i += n;
          if (n % 2) { arg += '"'; continue; }
          quoted = !quoted;
          continue;
        }
        arg += '\\'.repeat(n);
        i += n - 1;
        continue;
      }
      if (c === '"') {
        if (quoted && s[i + 1] === '"') { arg += '"'; i++; continue; }
        quoted = !quoted;
        continue;
      }
      if (!quoted && /\s/.test(c)) break;
      arg += c;
    }
    out.push(arg);
  }
  return out;
}

const PARAMS = [
  ['encodedcommand', 'enc', true], ['command', 'cmd', true], ['file', 'file', true], ['windowstyle', 'w', true], ['executionpolicy', 'ep', true],
  ['noprofile', 'nop', false], ['noninteractive', 'noni', false], ['nologo', 'nol', false], ['noexit', 'noe', false], ['sta', 'sta', false],
  ['mta', 'mta', false], ['version', 'v', true], ['inputformat', 'if', true], ['outputformat', 'of', true], ['configurationname', 'config', true],
  ['encodedarguments', 'ea', true], ['psconsolefile', 'psc', true],
];
function paramOf(token) {
  const name = token.slice(1).toLowerCase();
  if (!name) return null;
  if (name === 'ec' || name === 'e' || (name.startsWith('en') && 'encodedcommand'.startsWith(name))) return PARAMS[0];
  if (name === 'ep' || (name.startsWith('ex') && 'executionpolicy'.startsWith(name))) return PARAMS[4];
  if (name === 'c' || name === 'co' || 'command'.startsWith(name)) return PARAMS[1];
  return PARAMS.find(([full]) => full.startsWith(name)) ?? null;
}

/** powershell.exe argümanları → { code, flags, kind } ya da null */
function psLaunch(tokens, stdin = null) {
  const flags = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^[-/]/.test(t) && t.length > 1) {
      const p = paramOf(t);
      if (!p) return null;
      const [full, short, takes] = p;
      if (full === 'encodedcommand') {
        const v = tokens[i + 1];
        if (!v) return null;
        let text;
        try {
          text = decodeText(base64Decode(v), 'Unicode');
        } catch {
          return null;
        }
        // eslint-disable-next-line no-control-regex
        if (!text.trim() || /\u0000/.test(text)) return null;
        flags.push(`-${short}`);
        return { code: text, flags, kind: 'encodedcommand' };
      }
      if (full === 'command') {
        const rest = tokens.slice(i + 1);
        if (rest.length === 1 && rest[0] === '-') return stdin === null ? null : { code: stdin, flags, kind: 'stdin' };
        if (!rest.length) return null;
        return { code: rest.join(' '), flags, kind: 'command' };
      }
      if (full === 'file' || full === 'encodedarguments' || full === 'psconsolefile') return null;
      if (takes) {
        const v = tokens[i + 1];
        if (v === undefined) return null;
        flags.push(`-${short} ${v.toLowerCase()}`);
        i++;
      } else flags.push(`-${short}`);
      continue;
    }
    if (t === '-') return stdin === null ? null : { code: stdin, flags, kind: 'stdin' };
    // ilk konumsal argüman ve sonrası komuttur (PowerShell 5.1)
    return { code: tokens.slice(i).join(' '), flags, kind: 'command' };
  }
  return stdin === null ? null : { code: stdin, flags, kind: 'stdin' };
}

/** cmd sözdiziminde & && || | ayırıcıları (tırnak ve ^ bilinçli) */
function splitCmd(text, seps) {
  const parts = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '^' && !quoted && i + 1 < text.length) { cur += c + text[i + 1]; i++; continue; }
    if (c === '"') quoted = !quoted;
    if (!quoted) {
      const sep = seps.find((x) => text.startsWith(x, i));
      if (sep) { parts.push(cur); cur = ''; i += sep.length - 1; continue; }
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}
const uncaret = (s) => s.replace(/\^(.)/g, '$1');

/** cmd /c satırını yorumlar → { code, flags, kind } ya da null */
function cmdLaunch(rawArgs, depth = 0) {
  if (depth > 4) return null;
  let s = rawArgs.trim();
  // /q /d /v:on /e:on ... ardından /c /k /r
  for (;;) {
    const m = /^\/([a-z])(?::\w+)?(?=\s|"|$)/i.exec(s);
    if (!m) return null;
    s = s.slice(m[0].length).trimStart();
    if (/^[ckr]$/i.test(m[1])) break;
  }
  if (s.startsWith('"') && s.endsWith('"') && s.length > 1) s = s.slice(1, -1);
  const lines = [];
  const flags = [];
  let kind = 'cmd';
  for (const seg of splitCmd(s, ['&&', '||', '&'])) {
    const part = seg.trim();
    if (!part) continue;
    const set = /^set\s+(?:"([^=]+)=(.*)"|([^\s=]+)=(.*))$/is.exec(part);
    if (set) {
      const name = (set[1] ?? set[3]).trim();
      const value = uncaret(set[2] ?? set[4]);
      if (!/^\w+$/.test(name)) return null;
      lines.push(`$env:${name} = ${psQuote(value)}`);
      continue;
    }
    const piped = splitCmd(part, ['|']).map((x) => x.trim());
    let stdin = null;
    if (piped.length === 2) {
      const echo = /^echo[\s.](.*)$/is.exec(piped[0]);
      if (!echo) return null;
      stdin = uncaret(echo[1]).replace(/\s+$/, '');
    } else if (piped.length > 2) return null;
    let command = uncaret(piped.at(-1));
    // start [/b /min ...] ["başlık"] komut
    const start = /^start(?:\s+(?:\/\w+|""))*\s+(.*)$/is.exec(command);
    if (start) command = start[1];
    const tokens = argv(command);
    if (!tokens.length) continue;
    if (PS_EXE.test(tokens[0])) {
      const r = psLaunch(tokens.slice(1), stdin);
      if (!r) return null;
      flags.push(...r.flags);
      if (r.kind !== 'command') kind = r.kind;
      lines.push(r.code);
      continue;
    }
    if (CMD_EXE.test(tokens[0])) {
      const r = cmdLaunch(command.slice(command.toLowerCase().indexOf(tokens[0].toLowerCase()) + tokens[0].length), depth + 1);
      if (!r) return null;
      flags.push(...r.flags);
      lines.push(r.code);
      continue;
    }
    return null;
  }
  if (!lines.length) return null;
  return { code: lines.join('\n'), flags, kind };
}

export async function run(code, ctx) {
  const edits = [];
  const whole = ctx.ast.body.stmts.length === 1;
  walk(ctx.ast, (n, parent, key) => {
    if (n.type !== 'Pipeline' || key !== 'stmts' || n.redirs.length || n.background) return true;
    let stdin = null;
    let cmd = n.elements[0];
    if (n.elements.length === 2) {
      // 'KOD' | powershell -
      const r = ctx.scope().tryEval(n.elements[0]);
      if (!r || typeof r.value !== 'string') return true;
      stdin = r.value;
      cmd = n.elements[1];
    } else if (n.elements.length !== 1) return true;
    if (cmd.type !== 'Command' || cmd.redirs.length) return true;
    let exe = null;
    if (cmd.name.type === 'Bareword' && !cmd.name.complex) exe = cmd.name.value;
    else if (cmd.invoke === '&' && cmd.name.type === 'Str' && cmd.name.value !== null) exe = cmd.name.value;
    if (!exe) return true;
    const rawArgs = code.slice(cmd.name.end, cmd.end);
    let r = null;
    if (PS_EXE.test(exe)) r = psLaunch(argv(rawArgs), stdin);
    else if (CMD_EXE.test(exe) && stdin === null) r = cmdLaunch(rawArgs);
    if (!r) return true;
    const payload = r.code.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
    if (!payload.trim() || parse(payload).errors) {
      ctx.log(`launcher: ${r.kind} yükü ayrıştırılamadı, olduğu gibi bırakıldı`, 'warn');
      return true;
    }
    const top = whole && parent === ctx.ast.body;
    edits.push({ start: n.start, end: n.end, text: top ? payload : `& {\n${payload}\n}` });
    ctx.layer(r.kind, payload, r.flags);
    if (r.flags.length) ctx.log(`launcher: ${r.kind}, bayraklar: ${r.flags.join(' ')}`, 'info');
    return false;
  });
  if (!edits.length) return code;
  const out = applyEdits(code, edits);
  ctx.bump('launcher', out.applied);
  return out.code;
}
