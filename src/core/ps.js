// PowerShell ayrıştırıcısı: kaynak konumlu (start/end) sözdizimi ağacı. Geçişler ağacı okur, metni konumlarla düzenler.
// PowerShell'in iki ayrıştırma kipi vardır: komut kipi (çıplak sözcükler dizgedir, -x parametredir) ve ifade kipi
// (-f, -join işleçtir). Ayrıştırıcı kipi bağlama göre seçer. Tanınmayan ya da bozuk bir deyim düşürülmez: deyim sonuna
// kadar 'Raw' düğümü olur ve hata sayılır; bir geçişin çıktısı girdiden fazla hata üretirse hat dönüşümü geri alır.
//
// Düğümler (hepsinde type, start, end):
//   Script { body }, StmtList { stmts }, Pipeline { elements, redirs, background }, Chain { pipelines, ops },
//   Assign { target, op, value }, If { clauses: [{ cond, body }], elseBody }, While { cond, body }, DoLoop { body, cond, until },
//   For { init, cond, iter, body }, Foreach { variable, iterable, body }, Switch { cond, body }, Try { body, catches, fin },
//   Trap { body }, Function { name, params, body }, NamedBlock { name, body }, Flow { keyword, value }, Block { body }, Raw { reason },
//   Command { invoke: null|'&'|'.', name, args, redirs }, Param { name, value }, Redirect { op, target },
//   Str { value, quote: "'"|'"', here, parts: (string|node)[]|null }, Num { value }, Var { name, scope, key, splat, braced },
//   Bareword { value, complex, raw }, TypeLit { name }, Cast { typeName, operand }, Unary { op, operand }, Postfix { op, operand },
//   Binary { op, left, right }, ArrayLit { items }, Member { object, name, nameNode, static, args }, Index { object, index },
//   Paren { inner }, SubExpr { body }, ArrayExpr { body }, Hash { entries: [{ key, value }] }, ScriptBlock { body }

export class ParseError extends Error {
  constructor(msg, pos) { super(msg); this.pos = pos; }
}

const SQ = new Set(["'", '‘', '’', '‚', '‛']);
const DQ = new Set(['"', '“', '”', '„']);
const DASH = new Set(['-', '–', '—', '―']);
export const isSingleQuote = (c) => SQ.has(c);
export const isDoubleQuote = (c) => DQ.has(c);
const isWs = (c) => c === ' ' || c === '\t' || c === '\f' || c === '\v' || c === ' ' || c === '﻿' || (c >= ' ' && c <= '​') || c === '　';
const isNl = (c) => c === '\n' || c === '\r';
export const isWord = (c) => {
  if (c === undefined) return false;
  const x = c.charCodeAt(0);
  if (x < 128) return (x >= 48 && x <= 57) || (x >= 65 && x <= 90) || (x >= 97 && x <= 122) || x === 95;
  return /[\p{L}\p{N}]/u.test(c);
};
const isDigit = (c) => c >= '0' && c <= '9';
/** @' ya da @" ve ardından satır sonu: here-string başlangıcı */
export const isHereStart = (s, i) => s[i] === '@' && (SQ.has(s[i + 1]) || DQ.has(s[i + 1])) && /^[ \t]*\r?\n/.test(s.slice(i + 2, i + 64));

// Çift tırnak ve çıplak sözcükteki ` kaçışları
export const ESCAPES = { 0: '\0', a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };

const KEYWORDS = new Set(['if', 'elseif', 'else', 'while', 'for', 'foreach', 'do', 'until', 'switch', 'try', 'catch', 'finally', 'trap',
  'function', 'filter', 'workflow', 'configuration', 'param', 'begin', 'process', 'end', 'dynamicparam', 'return', 'throw', 'exit',
  'break', 'continue', 'class', 'enum', 'data', 'using', 'in', 'inlinescript', 'parallel', 'sequence', 'hidden', 'static', 'define', 'from', 'var']);
export const isKeyword = (w) => KEYWORDS.has(String(w).toLowerCase());

// İkili işleçler ve öncelik düzeyleri (büyük sayı daha sıkı bağlar). -f (6) ve .. ayrı düzeylerde ayrıştırılır.
const CMP = ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'like', 'notlike', 'match', 'notmatch', 'contains', 'notcontains', 'in', 'notin', 'replace', 'split'];
const OPS = new Map();
for (const op of CMP) for (const p of ['', 'i', 'c']) OPS.set(p + op, 2);
for (const op of ['join', 'is', 'isnot', 'as']) OPS.set(op, 2);
for (const op of ['band', 'bor', 'bxor', 'shl', 'shr']) OPS.set(op, 3);
for (const op of ['and', 'or', 'xor']) OPS.set(op, 1);
OPS.set('f', 6);
const UNARY_DASH = new Set(['not', 'bnot', 'split', 'join', 'isplit', 'csplit']);

/** Her zaman bir ağaç döner; bozuk deyimler Raw olur. @returns {{ ast, errors }} */
export function parse(code) {
  const p = new Parser(String(code));
  const ast = p.parseScript();
  return { ast, errors: p.errors };
}

/** parse; yığın taşması gibi beklenmeyen durumda null */
export function tryParse(code) {
  try {
    return parse(code);
  } catch (e) {
    if (e instanceof ParseError || e instanceof RangeError) return null;
    throw e;
  }
}

class Parser {
  constructor(src) {
    this.s = src;
    this.i = 0;
    this.errors = 0;
    this.depth = 0;
  }

  err(msg) { throw new ParseError(msg, this.i); }
  at(str) { return this.s.startsWith(str, this.i); }
  eof() { return this.i >= this.s.length; }
  enter() { if (++this.depth > 200) this.err('çok derin iç içe yapı'); }
  leave() { this.depth--; }

  /** Boşluk, satır devamı (` + satır sonu) ve yorumları atlar; nl true ise satır sonlarını da. Atlandıysa true */
  skip(nl = false) {
    const from = this.i;
    for (;;) {
      const c = this.s[this.i];
      if (isWs(c)) { this.i++; continue; }
      if (c === '`' && isNl(this.s[this.i + 1])) { this.i += this.s[this.i + 1] === '\r' && this.s[this.i + 2] === '\n' ? 3 : 2; continue; }
      if (c === '#') { while (!this.eof() && !isNl(this.s[this.i])) this.i++; continue; }
      if (c === '<' && this.s[this.i + 1] === '#') {
        const end = this.s.indexOf('#>', this.i + 2);
        this.i = end < 0 ? this.s.length : end + 2;
        continue;
      }
      if (nl && isNl(c)) { this.i++; continue; }
      break;
    }
    return this.i > from;
  }

  /** Deyim ayırıcıları (satır sonu, ;) ve boşluklar */
  skipSeps() {
    for (;;) {
      this.skip(true);
      if (this.s[this.i] === ';') { this.i++; continue; }
      break;
    }
  }

  parseScript() {
    const body = this.parseStmtList(null);
    while (!this.eof()) {
      // eşleşmeyen kapanış ayracı: Raw olarak korunur, ayrıştırma sürer
      this.errors++;
      const at = this.i;
      this.i++;
      body.stmts.push({ type: 'Raw', start: at, end: this.i, reason: 'eşleşmeyen kapanış' });
      const more = this.parseStmtList(null);
      body.stmts.push(...more.stmts);
    }
    body.end = this.i;
    return { type: 'Script', start: 0, end: this.s.length, body };
  }

  /** close: ')' | '}' | null (dosya sonu) */
  parseStmtList(close) {
    const start = this.i;
    const stmts = [];
    for (;;) {
      this.skipSeps();
      if (this.eof()) break;
      const c = this.s[this.i];
      if (c === ')' || c === '}') break;
      const at = this.i;
      try {
        stmts.push(this.parseStatement());
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.errors++;
        this.i = at;
        const end = this.skipRaw(close);
        stmts.push({ type: 'Raw', start: at, end, reason: e.message });
      }
      if (this.i === at) {
        this.errors++;
        this.i++;
        stmts.push({ type: 'Raw', start: at, end: this.i, reason: 'beklenmeyen karakter' });
      }
    }
    return { type: 'StmtList', start, end: this.i, stmts };
  }

  /** Bozuk deyimi dengeli biçimde satır sonuna, ;'e ya da kapanış ayracına kadar atlar */
  skipRaw(close) {
    let depth = 0;
    while (!this.eof()) {
      const c = this.s[this.i];
      if (depth === 0 && (isNl(c) || c === ';')) break;
      if (depth === 0 && close && c === close) break;
      if (SQ.has(c) || DQ.has(c) || isHereStart(this.s, this.i)) {
        try { this.readStringLike(); } catch { this.i = this.s.length; }
        continue;
      }
      if (c === '#' || (c === '<' && this.s[this.i + 1] === '#')) { this.skip(false); continue; }
      if (c === '`') { this.i += 2; continue; }
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') {
        if (depth === 0) break;
        depth--;
      }
      this.i++;
    }
    return Math.min(this.i, this.s.length);
  }

  readStringLike() {
    const c = this.s[this.i];
    if (c === '@') return this.parseHereString();
    if (SQ.has(c)) return this.parseSingle();
    return this.parseDouble();
  }

  /** Deyim başındaki anahtar sözcük adayı (küçük harfli) ya da null */
  wordAt() {
    const m = /^[A-Za-z]+/.exec(this.s.slice(this.i, this.i + 40));
    if (!m) return null;
    const after = this.s[this.i + m[0].length];
    if (isWord(after) || after === '-' || after === '.' || after === '\\' || after === ':' || after === '/') return null;
    return m[0].toLowerCase();
  }

  parseStatement() {
    this.enter();
    try {
      const start = this.i;
      // :etiket
      if (this.s[this.i] === ':' && isWord(this.s[this.i + 1])) {
        this.i++;
        while (isWord(this.s[this.i])) this.i++;
        this.skip(false);
      }
      const kw = this.wordAt();
      if (kw) {
        const st = this.parseKeyword(kw, start);
        if (st) return st;
      }
      return this.parseChain(start);
    } finally {
      this.leave();
    }
  }

  // ── anahtar sözcüklü yapılar ──
  parseKeyword(kw, start) {
    const save = this.i;
    const take = () => { this.i += kw.length; this.skip(false); };
    switch (kw) {
      case 'if': {
        take();
        const clauses = [{ cond: this.parseCond(), body: this.parseBlockNl() }];
        let elseBody = null;
        for (;;) {
          const back = this.i;
          this.skip(true);
          const w = this.wordAt();
          if (w === 'elseif') { this.i += 6; this.skip(true); clauses.push({ cond: this.parseCond(), body: this.parseBlockNl() }); continue; }
          if (w === 'else') { this.i += 4; elseBody = this.parseBlockNl(); break; }
          this.i = back;
          break;
        }
        return { type: 'If', start, end: this.i, clauses, elseBody };
      }
      case 'while': {
        take();
        const cond = this.parseCond();
        return { type: 'While', start, end: this.i, cond, body: this.parseBlockNl() };
      }
      case 'do': {
        take();
        const body = this.parseBlockNl();
        this.skip(true);
        const w = this.wordAt();
        if (w !== 'while' && w !== 'until') this.err('do sonrası while/until bekleniyor');
        this.i += w.length;
        this.skip(false);
        const cond = this.parseCond();
        return { type: 'DoLoop', start, end: this.i, body, cond, until: w === 'until' };
      }
      case 'for': {
        take();
        if (this.s[this.i] !== '(') { this.i = save; return null; }
        this.i++;
        const part = (end) => {
          this.skip(true);
          if (this.s[this.i] === end) return null;
          const st = this.parseStatement();
          this.skip(true);
          return st;
        };
        const init = part(';');
        if (this.s[this.i] === ';') this.i++;
        const cond = part(';');
        if (this.s[this.i] === ';') this.i++;
        const iter = part(')');
        this.expect(')');
        return { type: 'For', start, end: this.i, init, cond, iter, body: this.parseBlockNl() };
      }
      case 'foreach': {
        take();
        while (this.s[this.i] === '-') { this.i++; while (isWord(this.s[this.i])) this.i++; this.skip(false); }
        if (this.s[this.i] !== '(') { this.i = save; return null; }
        this.i++;
        this.skip(true);
        const variable = this.parseVariable();
        this.skip(true);
        if (this.wordAt() !== 'in') this.err('foreach: in bekleniyor');
        this.i += 2;
        this.skip(true);
        const iterable = this.parseChain(this.i);
        this.skip(true);
        this.expect(')');
        return { type: 'Foreach', start, end: this.i, variable, iterable, body: this.parseBlockNl() };
      }
      case 'switch': {
        take();
        while (this.s[this.i] === '-') {
          this.i++;
          const w = /^[A-Za-z]+/.exec(this.s.slice(this.i, this.i + 20))?.[0] ?? '';
          this.i += w.length;
          this.skip(false);
          if (/^file$/i.test(w)) { this.parseArgument(false); this.skip(false); }
        }
        let cond = null;
        if (this.s[this.i] === '(') cond = this.parseCond();
        return { type: 'Switch', start, end: this.i, cond, body: this.parseBlockNl() };
      }
      case 'try': {
        take();
        const body = this.parseBlockNl();
        const catches = [];
        let fin = null;
        for (;;) {
          const back = this.i;
          this.skip(true);
          const w = this.wordAt();
          if (w === 'catch') {
            this.i += 5;
            this.skip(false);
            while (this.s[this.i] === '[') {
              this.readTypeName();
              this.skip(false);
              if (this.s[this.i] === ',') { this.i++; this.skip(true); }
            }
            catches.push(this.parseBlockNl());
            continue;
          }
          if (w === 'finally') { this.i += 7; fin = this.parseBlockNl(); break; }
          this.i = back;
          break;
        }
        return { type: 'Try', start, end: this.i, body, catches, fin };
      }
      case 'trap': {
        take();
        if (this.s[this.i] === '[') { this.readTypeName(); this.skip(false); }
        return { type: 'Trap', start, end: this.i, body: this.parseBlockNl() };
      }
      case 'function': case 'filter': case 'workflow': case 'configuration': {
        take();
        const nameStart = this.i;
        while (!this.eof() && !isWs(this.s[this.i]) && !isNl(this.s[this.i]) && this.s[this.i] !== '(' && this.s[this.i] !== '{') this.i++;
        const name = this.s.slice(nameStart, this.i);
        if (!name) this.err('işlev adı yok');
        this.skip(true);
        let params = null;
        if (this.s[this.i] === '(') {
          const ps = this.i;
          this.skipBalanced('(', ')');
          params = { type: 'Raw', start: ps, end: this.i, reason: 'parametreler' };
          this.skip(true);
        }
        const body = this.parseBlock();
        return { type: 'Function', start, end: this.i, name, params, body };
      }
      case 'param': {
        if (!/^param\s*\(/i.test(this.s.slice(this.i, this.i + 64))) return null;
        take();
        this.skip(true);
        this.skipBalanced('(', ')');
        return { type: 'Raw', start, end: this.i, reason: 'param' };
      }
      case 'begin': case 'process': case 'end': case 'dynamicparam': {
        take();
        this.skip(true);
        if (this.s[this.i] !== '{') { this.i = save; return null; }
        const body = this.parseBlock();
        return { type: 'NamedBlock', start, end: this.i, name: kw, body };
      }
      case 'return': case 'throw': case 'exit': case 'break': case 'continue': {
        take();
        let value = null;
        const c = this.s[this.i];
        if (!this.eof() && !isNl(c) && c !== ';' && c !== '}' && c !== ')') value = this.parseChain(this.i);
        return { type: 'Flow', start, end: this.i, keyword: kw, value };
      }
      case 'class': case 'enum': case 'data': {
        take();
        while (!this.eof() && this.s[this.i] !== '{' && !isNl(this.s[this.i])) this.i++;
        this.skip(true);
        if (this.s[this.i] !== '{') this.err(`${kw}: { bekleniyor`);
        this.skipBalanced('{', '}');
        return { type: 'Raw', start, end: this.i, reason: kw };
      }
      case 'using': {
        take();
        while (!this.eof() && !isNl(this.s[this.i]) && this.s[this.i] !== ';') this.i++;
        return { type: 'Raw', start, end: this.i, reason: 'using' };
      }
      default:
        return null;
    }
  }

  parseCond() {
    this.skip(true);
    this.expect('(');
    this.skip(true);
    const st = this.parseStatement();
    this.skip(true);
    this.expect(')');
    return st;
  }

  expect(ch) {
    if (this.s[this.i] !== ch) this.err(`'${ch}' bekleniyor`);
    this.i++;
  }

  parseBlockNl() {
    this.skip(true);
    return this.parseBlock();
  }

  parseBlock() {
    const start = this.i;
    this.expect('{');
    const body = this.parseStmtList('}');
    this.expect('}');
    return { type: 'Block', start, end: this.i, body };
  }

  /** Dizge ve yorum bilen dengeli atlama */
  skipBalanced(open, close) {
    let depth = 0;
    while (!this.eof()) {
      const c = this.s[this.i];
      if (SQ.has(c) || DQ.has(c) || isHereStart(this.s, this.i)) { this.readStringLike(); continue; }
      if (c === '#' || (c === '<' && this.s[this.i + 1] === '#')) { this.skip(false); continue; }
      if (c === '`') { this.i += 2; continue; }
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) { this.i++; return; }
      }
      this.i++;
    }
    this.err(`'${close}' bekleniyor`);
  }

  // ── boru hatları ──
  parseChain(start) {
    const first = this.parsePipeline(start);
    const pipelines = [first];
    const ops = [];
    for (;;) {
      const back = this.i;
      this.skip(false);
      if (this.at('&&') || this.at('||')) {
        ops.push(this.s.slice(this.i, this.i + 2));
        this.i += 2;
        this.skip(true);
        pipelines.push(this.parsePipeline(this.i));
        continue;
      }
      this.i = back;
      break;
    }
    if (pipelines.length === 1) return first;
    return { type: 'Chain', start, end: this.i, pipelines, ops };
  }

  parsePipeline(start) {
    const first = this.parseElement();
    // atama: $x = ..., $a,$b = ..., [int]$x = ...
    if (first.type !== 'Command') {
      const back = this.i;
      this.skip(false);
      const m = /^(?:=(?!=)|\+=|-=|\*=|\/=|%=|\?\?=)/.exec(this.s.slice(this.i, this.i + 3));
      if (m) {
        this.i += m[0].length;
        this.skip(true);
        const value = this.parseStatement();
        return { type: 'Assign', start, end: value.end, target: first, op: m[0], value };
      }
      this.i = back;
    }
    const elements = [first];
    const redirs = [];
    let background = false;
    for (;;) {
      const back = this.i;
      this.skip(false);
      if (first.type !== 'Command' && elements.length === 1) {
        const r = this.tryRedirect();
        if (r) { redirs.push(r); continue; }
      }
      if (this.s[this.i] === '|' && this.s[this.i + 1] !== '|') {
        this.i++;
        this.skip(true);
        elements.push(this.parseElement());
        continue;
      }
      // PowerShell 7: satır başındaki | boru hattını sürdürür
      if (isNl(this.s[this.i])) {
        const save = this.i;
        this.skip(true);
        if (this.s[this.i] === '|' && this.s[this.i + 1] !== '|') {
          this.i++;
          this.skip(true);
          elements.push(this.parseElement());
          continue;
        }
        this.i = save;
      }
      if (this.s[this.i] === '&' && this.s[this.i + 1] !== '&') {
        this.i++;
        background = true;
        break;
      }
      this.i = back;
      break;
    }
    return { type: 'Pipeline', start, end: this.i, elements, redirs, background };
  }

  /** Boru hattı öğesi: komut ya da ifade */
  parseElement() {
    this.skip(false);
    const start = this.i;
    const c = this.s[this.i];
    const n = this.s[this.i + 1];
    if ((c === '&' && n !== '&') || (c === '.' && (isWs(n) || n === '(' || n === '$' || n === '{' || SQ.has(n) || DQ.has(n)))) {
      this.i++;
      this.skip(false);
      const name = this.parseArgument(true);
      return this.parseCommandRest(start, c, name);
    }
    if (this.startsExpression()) return this.parseExpr();
    const name = this.readBareword();
    if (!name.raw) this.err('komut bekleniyor');
    return this.parseCommandRest(start, null, name);
  }

  startsExpression() {
    const c = this.s[this.i];
    const n = this.s[this.i + 1];
    if (c === undefined) return false;
    if (c === '$' || SQ.has(c) || DQ.has(c) || c === '(' || c === '[' || c === '{' || c === '!' || c === ',') return true;
    if (c === '@' && (n === '(' || n === '{' || isHereStart(this.s, this.i))) return true;
    if (isDigit(c)) return this.numberAt() !== null;
    if (c === '.' && isDigit(n)) return true;
    if ((DASH.has(c) || c === '+') && (isDigit(n) || (n === '.' && isDigit(this.s[this.i + 2])))) return true;
    if (c === '+' && n === '+') return true;
    if (DASH.has(c) && DASH.has(n)) return true;
    // tekli artı/eksi: +$(), -$x, -(...)
    if ((c === '+' || DASH.has(c)) && (n === '$' || n === '(' || n === '[' || n === '@' || SQ.has(n) || DQ.has(n))) return true;
    if (DASH.has(c)) {
      const m = /^[A-Za-z]+/.exec(this.s.slice(this.i + 1, this.i + 12));
      if (m && UNARY_DASH.has(m[0].toLowerCase()) && !isWord(this.s[this.i + 1 + m[0].length])) return true;
    }
    return false;
  }

  parseCommandRest(start, invoke, name) {
    const args = [];
    const redirs = [];
    for (;;) {
      this.skip(false);
      const c = this.s[this.i];
      if (this.eof() || isNl(c) || c === ';' || c === ')' || c === '}' || c === '|' || c === '&') break;
      const r = this.tryRedirect();
      if (r) { redirs.push(r); continue; }
      if (DASH.has(c) && DASH.has(this.s[this.i + 1]) && this.s[this.i + 2] === '%') {
        // --% durdurma işareti: satırın geri kalanı ham
        const s = this.i;
        while (!this.eof() && !isNl(this.s[this.i])) this.i++;
        const raw = this.s.slice(s, this.i);
        args.push({ type: 'Bareword', start: s, end: this.i, value: raw, complex: true, raw });
        continue;
      }
      if (DASH.has(c) && (isWord(this.s[this.i + 1]) || this.s[this.i + 1] === '`' || this.s[this.i + 1] === '?') && !this.numberFollows()) {
        args.push(this.parseParam());
        continue;
      }
      args.push(this.parseArgument(false));
    }
    return { type: 'Command', start, end: this.i, invoke, name, args, redirs };
  }

  numberFollows() {
    const n = this.numberAt();
    return n !== null && this.argEnd(this.s[this.i + n.len]);
  }

  tryRedirect() {
    const m = /^(?:[1-6*]?>>?(?:&[12])?|<(?!#))/.exec(this.s.slice(this.i, this.i + 5));
    if (!m) return null;
    const start = this.i;
    this.i += m[0].length;
    if (/&[12]$/.test(m[0])) return { type: 'Redirect', start, end: this.i, op: m[0], target: null };
    this.skip(false);
    const target = this.parseArgument(false);
    return { type: 'Redirect', start, end: this.i, op: m[0], target };
  }

  parseParam() {
    const start = this.i;
    this.i++;
    let name = '';
    while (!this.eof()) {
      const c = this.s[this.i];
      if (c === '`' && !isNl(this.s[this.i + 1] ?? '\n')) { name += this.s[this.i + 1]; this.i += 2; continue; }
      if (isWs(c) || isNl(c) || c === ':' || ';|)}&(,{'.includes(c) || SQ.has(c) || DQ.has(c)) break;
      name += c;
      this.i++;
    }
    let value = null;
    if (this.s[this.i] === ':') {
      this.i++;
      value = this.parseArgument(false);
    }
    return { type: 'Param', start, end: this.i, name, value };
  }

  /** Komut kipi argümanı (virgülle dizi olabilir). nameOnly: komut adı konumu */
  parseArgument(nameOnly) {
    const start = this.i;
    const first = this.parseArgValue(nameOnly);
    if (nameOnly) return first;
    const items = [first];
    for (;;) {
      const back = this.i;
      this.skip(false);
      if (this.s[this.i] === ',') {
        this.i++;
        this.skip(true);
        items.push(this.parseArgValue(false));
        continue;
      }
      this.i = back;
      break;
    }
    if (items.length === 1) return first;
    return { type: 'ArrayLit', start, end: this.i, items };
  }

  parseArgValue(nameOnly) {
    const c = this.s[this.i];
    const n = this.s[this.i + 1];
    if (c === undefined) this.err('argüman bekleniyor');
    if (c === '@' && isWord(n) && !nameOnly) {
      const start = this.i;
      this.i++;
      let name = '';
      while (isWord(this.s[this.i])) name += this.s[this.i++];
      return { type: 'Var', start, end: this.i, name, scope: '', key: name.toLowerCase(), splat: true, braced: false };
    }
    if (c === '$' || SQ.has(c) || DQ.has(c) || c === '(' || c === '{' || (c === '@' && (n === '(' || n === '{' || isHereStart(this.s, this.i)))) {
      const e = this.parsePostfix(this.parsePrimary(), true);
      // '$a'b gibi bitişik parçalar: tek karmaşık sözcük
      if (!this.eof() && !this.argEnd(this.s[this.i])) {
        const rest = this.readBareword();
        const raw = this.s.slice(e.start, rest.end);
        return { type: 'Bareword', start: e.start, end: rest.end, value: raw, complex: true, raw, parts: [e, ...rest.parts] };
      }
      return e;
    }
    if (c === '[' && !nameOnly) {
      // [tip]::Üye komut kipinde de ifadedir
      const save = this.i;
      try {
        const t = this.parsePrimary();
        if (t.type === 'TypeLit' && this.at('::')) return this.parsePostfix(t, true);
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
      }
      this.i = save;
    }
    if (!nameOnly && (isDigit(c) || ((DASH.has(c) || c === '+' || c === '.') && (isDigit(n) || n === '.')))) {
      const num = this.numberAt();
      if (num !== null && this.argEnd(this.s[this.i + num.len])) {
        const start = this.i;
        this.i += num.len;
        return { type: 'Num', start, end: this.i, value: num.value };
      }
    }
    return this.readBareword();
  }

  argEnd(c) {
    return c === undefined || isWs(c) || isNl(c) || ';|)}&,({'.includes(c);
  }

  /** Çıplak sözcük (komut adı ya da argüman); ` kaçışları çözülür */
  readBareword() {
    const start = this.i;
    let value = '';
    let complex = false;
    // sözcüğe gömülü dizge ve değişkenler (ab"$x", a$b): değerlendirilmez ama okuma olarak ağaçta kalır
    const parts = [];
    while (!this.eof()) {
      const c = this.s[this.i];
      if (c === '`') {
        const d = this.s[this.i + 1];
        if (d === undefined) { this.i++; break; }
        if (isNl(d)) break;
        value += ESCAPES[d] ?? d;
        this.i += 2;
        continue;
      }
      if (isWs(c) || isNl(c) || ';|)}&,({'.includes(c)) break;
      if (SQ.has(c) || DQ.has(c)) {
        // ab'cd' ya da ab"$x": tek sözcükte birleşir
        complex = true;
        parts.push(this.readStringLike());
        continue;
      }
      if (c === '$' && (isWord(this.s[this.i + 1]) || this.s[this.i + 1] === '{' || this.s[this.i + 1] === '(' || this.s[this.i + 1] === '?')) {
        complex = true;
        if (this.s[this.i + 1] === '(') {
          const s0 = this.i;
          this.i += 2;
          const body = this.parseStmtList(')');
          this.expect(')');
          parts.push({ type: 'SubExpr', start: s0, end: this.i, body });
          continue;
        }
        parts.push(this.parseVariable());
        continue;
      }
      if (c === '>' || (c === '<' && this.s[this.i + 1] !== '#')) break;
      value += c;
      this.i++;
    }
    const raw = this.s.slice(start, this.i);
    return { type: 'Bareword', start, end: this.i, value: complex ? raw : value, complex, raw, parts };
  }

  // ── ifadeler ──
  parseExpr() { return this.binaryLoop(this.parseNeg(), 1, false); }

  /** İkili işleç (yerinde, ilerlemez): { op, len, prec } */
  peekOp() {
    const c = this.s[this.i];
    const n = this.s[this.i + 1];
    if (c === undefined) return null;
    if (DASH.has(c)) {
      if (n === '=' || DASH.has(n)) return null;
      const m = /^[A-Za-z]+/.exec(this.s.slice(this.i + 1, this.i + 14));
      if (m) {
        const w = m[0].toLowerCase();
        if (!isWord(this.s[this.i + 1 + m[0].length]) && OPS.has(w)) return { op: `-${w}`, len: 1 + m[0].length, prec: OPS.get(w) };
        return null;
      }
      return { op: '-', len: 1, prec: 4 };
    }
    if (c === '+' && n !== '=' && n !== '+') return { op: '+', len: 1, prec: 4 };
    if ((c === '*' || c === '/' || c === '%') && n !== '=') {
      if (c === '*' && n === '>') return null;
      return { op: c, len: 1, prec: 5 };
    }
    return null;
  }

  /** inArgs: yöntem argümanı (satır sonları atlanır, -f de bu döngüde) */
  binaryLoop(left, minPrec, inArgs) {
    for (;;) {
      const back = this.i;
      this.skip(inArgs);
      const op = this.peekOp();
      if (!op || op.prec < minPrec || (!inArgs && op.prec === 6)) { this.i = back; return left; }
      this.i += op.len;
      this.skip(true);
      let right = inArgs ? this.parseArgOperand() : this.parseNeg();
      for (;;) {
        const b2 = this.i;
        this.skip(inArgs);
        const next = this.peekOp();
        this.i = b2;
        if (!next || next.prec <= op.prec || (!inArgs && next.prec === 6)) break;
        right = this.binaryLoop(right, op.prec + 1, inArgs);
      }
      left = { type: 'Binary', start: left.start, end: right.end, op: op.op, left, right };
    }
  }

  parseNeg() {
    const c = this.s[this.i];
    const n = this.s[this.i + 1];
    if (DASH.has(c) && !isDigit(n) && n !== '.' && !DASH.has(n)) {
      const m = /^[A-Za-z]+/.exec(this.s.slice(this.i + 1, this.i + 8));
      const w = m?.[0].toLowerCase();
      if (w === 'bnot' && !isWord(this.s[this.i + 5])) {
        const start = this.i;
        this.i += 5;
        this.skip(true);
        const operand = this.parseNeg();
        return { type: 'Unary', start, end: operand.end, op: '-bnot', operand };
      }
      if (!m) {
        const start = this.i;
        this.i++;
        this.skip(false);
        const operand = this.parseNeg();
        return { type: 'Unary', start, end: operand.end, op: '-', operand };
      }
    }
    if (c === '+' && n !== '+' && !isDigit(n)) {
      const start = this.i;
      this.i++;
      this.skip(false);
      const operand = this.parseNeg();
      return { type: 'Unary', start, end: operand.end, op: '+', operand };
    }
    return this.parseFormat();
  }

  parseFormat() {
    let left = this.parseRange();
    for (;;) {
      const back = this.i;
      this.skip(false);
      const op = this.peekOp();
      if (!op || op.op !== '-f') { this.i = back; return left; }
      this.i += op.len;
      this.skip(true);
      const right = this.parseRange();
      left = { type: 'Binary', start: left.start, end: right.end, op: '-f', left, right };
    }
  }

  parseRange() {
    let left = this.parseNot();
    for (;;) {
      const back = this.i;
      this.skip(false);
      if (this.at('..') && this.s[this.i + 2] !== '.') {
        this.i += 2;
        this.skip(true);
        const right = this.parseNot();
        left = { type: 'Binary', start: left.start, end: right.end, op: '..', left, right };
        continue;
      }
      this.i = back;
      return left;
    }
  }

  parseNot() {
    const c = this.s[this.i];
    if (c === '!' || (DASH.has(c) && this.s.slice(this.i + 1, this.i + 4).toLowerCase() === 'not' && !isWord(this.s[this.i + 4]))) {
      const start = this.i;
      this.i += c === '!' ? 1 : 4;
      this.skip(true);
      const operand = this.parseNot();
      return { type: 'Unary', start, end: operand.end, op: '-not', operand };
    }
    return this.parseComma();
  }

  parseComma() {
    const start = this.i;
    if (this.s[this.i] === ',') {
      // tekli virgül: tek öğeli dizi
      this.i++;
      this.skip(true);
      const operand = this.parseComma();
      return { type: 'Unary', start, end: operand.end, op: ',', operand };
    }
    const first = this.parsePrefix();
    const items = [first];
    for (;;) {
      const back = this.i;
      this.skip(false);
      if (this.s[this.i] === ',') {
        this.i++;
        this.skip(true);
        items.push(this.parsePrefix());
        continue;
      }
      this.i = back;
      break;
    }
    if (items.length === 1) return first;
    return { type: 'ArrayLit', start, end: items.at(-1).end, items };
  }

  parsePrefix() {
    const c = this.s[this.i];
    const n = this.s[this.i + 1];
    const start = this.i;
    if (DASH.has(c)) {
      const m = /^[A-Za-z]+/.exec(this.s.slice(this.i + 1, this.i + 10));
      const w = m?.[0].toLowerCase();
      const solo = m && !isWord(this.s[this.i + 1 + m[0].length]);
      if (solo && (w === 'split' || w === 'join' || w === 'isplit' || w === 'csplit' || w === 'not' || w === 'bnot')) {
        this.i += 1 + m[0].length;
        this.skip(true);
        const operand = this.parsePrefix();
        return { type: 'Unary', start, end: operand.end, op: `-${w}`, operand };
      }
      if (m) this.err('beklenmeyen işleç');
      if (DASH.has(n)) {
        this.i += 2;
        const operand = this.parsePrefix();
        return { type: 'Unary', start, end: operand.end, op: '--', operand };
      }
      if (!isDigit(n) && n !== '.') {
        this.i++;
        this.skip(false);
        const operand = this.parsePrefix();
        return { type: 'Unary', start, end: operand.end, op: '-', operand };
      }
    }
    if (c === '+' && n === '+') {
      this.i += 2;
      const operand = this.parsePrefix();
      return { type: 'Unary', start, end: operand.end, op: '++', operand };
    }
    if (c === '!') return this.parseNot();
    if (c === '[') {
      const t = this.parsePrimary();
      if (t.type !== 'TypeLit') return this.parsePostfix(t, false);
      if (this.at('::')) return this.parsePostfix(t, false);
      // [tip] işlenen: dönüştürme (aradaki boşluğa izin var, satır sonuna değil)
      const back = this.i;
      this.skip(false);
      const d = this.s[this.i];
      if (d !== undefined && !isNl(d) && (this.startsExpression() || d === '[')) {
        const operand = this.parsePrefix();
        return { type: 'Cast', start, end: operand.end, typeName: t.name, typeNode: t, operand };
      }
      this.i = back;
      return this.parsePostfix(t, false);
    }
    return this.parsePostfix(this.parsePrimary(), false);
  }

  numberAt() {
    const m = /^[-+–—―]?(?:0[xX][0-9a-fA-F]+|(?:\d+(?:\.(?!\.)\d*)?|\.\d+)(?:[eE][-+]?\d+)?)(?:[uU][lL]|[lLdDuUyYnN])?(?:[kKmMgGtTpP][bB])?/.exec(this.s.slice(this.i, this.i + 80));
    if (!m) return null;
    const after = this.s[this.i + m[0].length];
    if (isWord(after) || (after === '.' && isDigit(this.s[this.i + m[0].length + 1]))) return null;
    let raw = m[0].replace(/^[–—―]/, '-');
    let mult = 1;
    const unit = /([kmgtp])b$/i.exec(raw);
    if (unit) { mult = 1024 ** ('kmgtp'.indexOf(unit[1].toLowerCase()) + 1); raw = raw.slice(0, -2); }
    raw = raw.replace(/(?:[uU][lL]|[lLdDuUyYnN])$/, '');
    const neg = raw.startsWith('-');
    const body = raw.replace(/^[-+]/, '');
    let value = /^0x/i.test(body) ? parseInt(body.slice(2), 16) : Number(body);
    // 0xFFFFFFFF gibi 8 haneli onaltılık değişmezler int32 taşmasıyla negatif olur
    if (/^0x/i.test(body) && body.length - 2 === 8 && value > 0x7fffffff) value -= 0x100000000;
    if (!Number.isFinite(value)) return null;
    value *= mult;
    return { len: m[0].length, value: neg ? -value : value };
  }

  parsePrimary() {
    this.enter();
    try {
      return this.primary();
    } finally {
      this.leave();
    }
  }

  primary() {
    const start = this.i;
    const c = this.s[this.i];
    const n = this.s[this.i + 1];
    if (c === undefined) this.err('ifade bekleniyor');
    if (c === '$' && n === '(') {
      this.i += 2;
      const body = this.parseStmtList(')');
      this.expect(')');
      return { type: 'SubExpr', start, end: this.i, body };
    }
    if (c === '@' && n === '(') {
      this.i += 2;
      const body = this.parseStmtList(')');
      this.expect(')');
      return { type: 'ArrayExpr', start, end: this.i, body };
    }
    if (c === '@' && n === '{') return this.parseHash();
    if (isHereStart(this.s, this.i)) return this.parseHereString();
    if (c === '$') return this.parseVariable();
    if (SQ.has(c)) return this.parseSingle();
    if (DQ.has(c)) return this.parseDouble();
    if (c === '(') {
      this.i++;
      this.skip(true);
      let inner = null;
      if (this.s[this.i] !== ')') {
        inner = this.parseStatement();
        this.skip(true);
      }
      this.expect(')');
      return { type: 'Paren', start, end: this.i, inner };
    }
    if (c === '{') {
      this.i++;
      const body = this.parseStmtList('}');
      this.expect('}');
      return { type: 'ScriptBlock', start, end: this.i, body };
    }
    if (c === '[') {
      const name = this.readTypeName();
      return { type: 'TypeLit', start, end: this.i, name };
    }
    const num = this.numberAt();
    if (num !== null) {
      this.i += num.len;
      return { type: 'Num', start, end: this.i, value: num.value };
    }
    this.err('ifade bekleniyor');
  }

  readTypeName() {
    const start = this.i;
    this.expect('[');
    let depth = 1;
    while (!this.eof() && depth) {
      const c = this.s[this.i];
      if (c === '[') depth++;
      else if (c === ']') depth--;
      else if (isNl(c) || c === '(' || c === '{' || c === '$' || SQ.has(c) || DQ.has(c)) this.err('tür adı bozuk');
      this.i++;
    }
    if (depth) this.err('] bekleniyor');
    const name = this.s.slice(start + 1, this.i - 1).replace(/`/g, '').trim();
    if (!name || !/^[\p{L}\p{N}_.+,[\] ]+$/u.test(name)) this.err('tür adı bozuk');
    return name;
  }

  parseHash() {
    const start = this.i;
    this.i += 2;
    const entries = [];
    for (;;) {
      this.skipSeps();
      if (this.s[this.i] === '}') break;
      if (this.eof()) this.err('} bekleniyor');
      let key;
      const c = this.s[this.i];
      if (SQ.has(c) || DQ.has(c) || c === '$' || c === '(' || isDigit(c)) key = this.parsePostfix(this.parsePrimary(), false);
      else {
        const ks = this.i;
        while (!this.eof() && !isWs(this.s[this.i]) && this.s[this.i] !== '=' && !isNl(this.s[this.i]) && this.s[this.i] !== '}') this.i++;
        const raw = this.s.slice(ks, this.i);
        if (!raw) this.err('anahtar bekleniyor');
        key = { type: 'Bareword', start: ks, end: this.i, value: raw, complex: false, raw };
      }
      this.skip(false);
      this.expect('=');
      this.skip(true);
      const value = this.parseStatement();
      entries.push({ key, value });
    }
    this.expect('}');
    return { type: 'Hash', start, end: this.i, entries };
  }

  /** $ad, ${ad}, $env:ad, $script:ad, $_, $?, $$, $^ */
  parseVariable() {
    const start = this.i;
    if (this.s[this.i] !== '$') this.err('değişken bekleniyor');
    this.i++;
    let name = '';
    let braced = false;
    if (this.s[this.i] === '{') {
      braced = true;
      this.i++;
      let raw = '';
      while (!this.eof() && this.s[this.i] !== '}') {
        if (this.s[this.i] === '`' && this.i + 1 < this.s.length) { raw += this.s.slice(this.i, this.i + 2); this.i += 2; continue; }
        raw += this.s[this.i++];
      }
      this.expect('}');
      // ${sürücü:yol}: ` yol kaçışıdır (${e`Nv:x} = $env:x); düz adda yalnızca { } ` kaçışlıdır, diğer ` adın parçasıdır
      name = raw.replace(/`([\s\S])/g, (m, d) => (raw.includes(':') || '{}`'.includes(d) ? d : m));
    } else if (this.s[this.i] === '?' || this.s[this.i] === '$' || this.s[this.i] === '^') {
      name = this.s[this.i++];
    } else {
      while (isWord(this.s[this.i])) name += this.s[this.i++];
      // kapsam: env:, script:, global:, local:, private:, using:, variable:
      if (this.s[this.i] === ':' && name && isWord(this.s[this.i + 1])) {
        name += ':';
        this.i++;
        while (isWord(this.s[this.i])) name += this.s[this.i++];
      }
      if (!name) this.err('değişken adı yok');
    }
    return makeVar(start, this.i, name, braced);
  }

  parseSingle() {
    const start = this.i;
    this.i++;
    let value = '';
    for (;;) {
      if (this.eof()) this.err('dizge kapanmadı');
      const c = this.s[this.i];
      if (SQ.has(c)) {
        if (SQ.has(this.s[this.i + 1])) { value += c; this.i += 2; continue; }
        this.i++;
        break;
      }
      value += c;
      this.i++;
    }
    return { type: 'Str', start, end: this.i, value, quote: "'", here: false, parts: null };
  }

  parseDouble() {
    const start = this.i;
    this.i++;
    const parts = [];
    let lit = '';
    for (;;) {
      if (this.eof()) this.err('dizge kapanmadı');
      const c = this.s[this.i];
      if (c === '`') {
        const d = this.s[this.i + 1];
        if (d === 'u' && this.s[this.i + 2] === '{') {
          const m = /^`u\{([0-9a-fA-F]{1,6})\}/.exec(this.s.slice(this.i, this.i + 10));
          if (m) { lit += String.fromCodePoint(Math.min(parseInt(m[1], 16), 0x10ffff)); this.i += m[0].length; continue; }
        }
        if (d === undefined) this.err('dizge kapanmadı');
        lit += ESCAPES[d] ?? d;
        this.i += 2;
        continue;
      }
      if (DQ.has(c)) {
        if (DQ.has(this.s[this.i + 1])) { lit += c; this.i += 2; continue; }
        this.i++;
        break;
      }
      if (c === '$') {
        const sub = this.stringExpansion();
        if (sub) {
          if (lit) parts.push(lit);
          lit = '';
          parts.push(sub);
          continue;
        }
      }
      lit += c;
      this.i++;
    }
    if (lit || !parts.length) parts.push(lit);
    const expandable = parts.some((p) => typeof p !== 'string');
    return { type: 'Str', start, end: this.i, value: expandable ? null : parts.join(''), quote: '"', here: false, parts: expandable ? parts : null };
  }

  /** Dizge içinde $ genişletmesi: $( ), ${ }, $ad; değilse null */
  stringExpansion() {
    const n = this.s[this.i + 1];
    const start = this.i;
    if (n === '(') {
      this.i += 2;
      const body = this.parseStmtList(')');
      this.expect(')');
      return { type: 'SubExpr', start, end: this.i, body };
    }
    if (n === '{' || isWord(n) || n === '?' || n === '$' || n === '^') return this.parseVariable();
    return null;
  }

  parseHereString() {
    const start = this.i;
    const dq = DQ.has(this.s[this.i + 1]);
    const closer = dq ? DQ : SQ;
    this.i += 2;
    while (isWs(this.s[this.i])) this.i++;
    if (this.s[this.i] === '\r') this.i++;
    if (this.s[this.i] !== '\n') this.err('here-string satır sonu bekliyor');
    this.i++;
    const bodyStart = this.i;
    let bodyEnd;
    // kapanış satır başındadır ("@ / '@); gövde son satır sonunu içermez
    for (let j = bodyStart; ;) {
      let k = j;
      while (this.s[k] === ' ' || this.s[k] === '\t') k++;
      if (closer.has(this.s[k]) && this.s[k + 1] === '@') {
        bodyEnd = j === bodyStart ? j : j - 1;
        if (bodyEnd > bodyStart && this.s[bodyEnd - 1] === '\r') bodyEnd--;
        this.i = k + 2;
        break;
      }
      const nl = this.s.indexOf('\n', j);
      if (nl < 0) this.err('here-string kapanmadı');
      j = nl + 1;
    }
    if (!dq) return { type: 'Str', start, end: this.i, value: this.s.slice(bodyStart, bodyEnd).replace(/\r\n/g, '\n'), quote: "'", here: true, parts: null };
    // genişletilebilir here-string: ` kaçışları ve $ genişletmesi
    const endAll = this.i;
    this.i = bodyStart;
    const parts = [];
    let lit = '';
    while (this.i < bodyEnd) {
      const c = this.s[this.i];
      if (c === '`' && this.i + 1 < bodyEnd) { lit += ESCAPES[this.s[this.i + 1]] ?? this.s[this.i + 1]; this.i += 2; continue; }
      if (c === '$') {
        const sub = this.stringExpansion();
        if (sub) {
          if (lit) parts.push(lit);
          lit = '';
          parts.push(sub);
          continue;
        }
      }
      if (c === '\r' && this.s[this.i + 1] === '\n') { this.i++; continue; }
      lit += c;
      this.i++;
    }
    this.i = endAll;
    if (lit || !parts.length) parts.push(lit);
    const expandable = parts.some((p) => typeof p !== 'string');
    return { type: 'Str', start, end: this.i, value: expandable ? null : parts.join(''), quote: '"', here: true, parts: expandable ? parts : null };
  }

  /** Son ek işleçler: .üye, ::üye, (argümanlar), [indeks], ++/-- (boşluksuz) */
  parsePostfix(node, argMode) {
    for (;;) {
      const c = this.s[this.i];
      const n = this.s[this.i + 1];
      if ((c === '.' && n !== '.') || (c === ':' && n === ':') || (c === '?' && n === '.')) {
        const isStatic = c === ':';
        const save = this.i;
        this.i += c === '.' ? 1 : 2;
        const nameStart = this.i;
        let name = null;
        let nameNode;
        const d = this.s[this.i];
        if (isWord(d) || (d === '`' && isWord(this.s[this.i + 1]))) {
          let w = '';
          while (isWord(this.s[this.i]) || (this.s[this.i] === '`' && isWord(this.s[this.i + 1]))) {
            if (this.s[this.i] === '`') { w += this.s[this.i + 1]; this.i += 2; continue; }
            w += this.s[this.i++];
          }
          name = w;
          nameNode = { type: 'Ident', start: nameStart, end: this.i, value: w };
        } else if (SQ.has(d) || DQ.has(d) || d === '$' || d === '(') {
          nameNode = d === '$' ? this.parseVariable() : this.parsePrimary();
          if (nameNode.type === 'Str' && nameNode.value !== null) name = nameNode.value;
        } else {
          this.i = save;
          return node;
        }
        let args = null;
        if (this.s[this.i] === '(') args = this.parseCallArgs();
        node = { type: 'Member', start: node.start, end: this.i, object: node, name, nameNode, static: isStatic, nullCond: c === '?', args };
        continue;
      }
      if (c === '[' && node.type !== 'TypeLit') {
        const save = this.i;
        this.i++;
        this.skip(true);
        if (this.s[this.i] === ']') { this.i = save; return node; }
        let index;
        try {
          index = this.parseStatement();
          this.skip(true);
          this.expect(']');
        } catch (e) {
          if (argMode && e instanceof ParseError) { this.i = save; return node; }
          throw e;
        }
        node = { type: 'Index', start: node.start, end: this.i, object: node, index };
        continue;
      }
      if (!argMode && node.type === 'Var' && ((c === '+' && n === '+') || (DASH.has(c) && DASH.has(n)))) {
        this.i += 2;
        node = { type: 'Postfix', start: node.start, end: this.i, op: c === '+' ? '++' : '--', operand: node };
        continue;
      }
      return node;
    }
  }

  parseCallArgs() {
    this.expect('(');
    const args = [];
    this.skip(true);
    if (this.s[this.i] === ')') { this.i++; return args; }
    for (;;) {
      this.skip(true);
      args.push(this.binaryLoop(this.parseArgOperand(), 1, true));
      this.skip(true);
      if (this.s[this.i] === ',') { this.i++; continue; }
      this.expect(')');
      return args;
    }
  }

  /** Yöntem argümanı işleneni: virgül ayırıcıdır, dizi kurmaz */
  parseArgOperand() {
    const c = this.s[this.i];
    const n = this.s[this.i + 1];
    const start = this.i;
    if (c === ',') {
      this.i++;
      this.skip(true);
      const operand = this.parseArgOperand();
      return { type: 'Unary', start, end: operand.end, op: ',', operand };
    }
    if (c === '!' || (DASH.has(c) && /^not(?![\w])/i.test(this.s.slice(this.i + 1, this.i + 5)))) {
      this.i += c === '!' ? 1 : 4;
      this.skip(true);
      const operand = this.parseArgOperand();
      return { type: 'Unary', start, end: operand.end, op: '-not', operand };
    }
    if (DASH.has(c) && !isDigit(n) && n !== '.' && !/^[A-Za-z]/.test(n ?? '') && !DASH.has(n)) {
      this.i++;
      const operand = this.parseArgOperand();
      return { type: 'Unary', start, end: operand.end, op: '-', operand };
    }
    let left = this.parsePrefix();
    for (;;) {
      const back = this.i;
      this.skip(true);
      if (this.at('..') && this.s[this.i + 2] !== '.') {
        this.i += 2;
        this.skip(true);
        const right = this.parsePrefix();
        left = { type: 'Binary', start: left.start, end: right.end, op: '..', left, right };
        continue;
      }
      this.i = back;
      return left;
    }
  }
}

export function makeVar(start, end, rawName, braced) {
  const m = /^(env|script|global|local|private|using|variable|function|alias|workflow):(.*)$/is.exec(rawName);
  let scope = '';
  let name = rawName;
  if (m) { scope = m[1].toLowerCase(); name = m[2]; }
  const key = scope === 'env' ? `env:${name.toLowerCase()}` : scope === 'function' || scope === 'alias' ? `${scope}:${name.toLowerCase()}` : name.toLowerCase();
  return { type: 'Var', start, end, name, scope, key, splat: false, braced };
}

// ── ağaç yardımcıları ──

/** Derinlik öncelikli (ön sıra) gezinme; fn false dönerse alt düğümlere inilmez. Yığınla yinelemeli: çok uzun
 *  'a'+'b'+... zincirleri (binlerce düzey) çağrı yığınını taşırmaz. */
export function walk(root, fn, rootParent = null, rootKey = null) {
  const stack = [[root, rootParent, rootKey]];
  while (stack.length) {
    const [node, parent, key] = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push([node[i], parent, key]);
      continue;
    }
    if (node.type === undefined) {
      // { key, value } gibi yardımcı nesneler
      const ks = Object.keys(node);
      for (let i = ks.length - 1; i >= 0; i--) { const v = node[ks[i]]; if (v && typeof v === 'object') stack.push([v, parent, ks[i]]); }
      continue;
    }
    if (fn(node, parent, key) === false) continue;
    const ks = Object.keys(node);
    for (let i = ks.length - 1; i >= 0; i--) {
      const k = ks[i];
      if (k === 'start' || k === 'end' || k === 'type' || k === 'typeNode') continue;
      const v = node[k];
      if (v && typeof v === 'object') stack.push([v, node, k]);
    }
  }
}

/** Çakışmayan düzenlemeleri uygular: [{ start, end, text }] */
export function applyEdits(code, edits) {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = '';
  let at = 0;
  let applied = 0;
  for (const e of sorted) {
    if (e.start < at) continue;
    out += code.slice(at, e.start) + e.text;
    at = e.end;
    applied++;
  }
  return { code: out + code.slice(at), applied };
}

/** PowerShell dizge değişmezi: yazdırılabilirse tek tırnak, değilse çift tırnak + kaçışlar */
export function psQuote(s) {
  s = String(s);
  // eslint-disable-next-line no-control-regex
  if (!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) return `'${s.replace(/['‘’‚‛]/g, (q) => q + q)}'`;
  const REV = { '\0': '`0', '\x07': '`a', '\b': '`b', '\x1b': '`e', '\f': '`f', '\n': '`n', '\r': '`r', '\t': '`t', '\v': '`v' };
  let out = '"';
  for (const ch of s) {
    if (REV[ch]) out += REV[ch];
    else if (ch === '`' || ch === '$' || DQ.has(ch)) out += `\`${ch}`;
    // eslint-disable-next-line no-control-regex
    else if (/[\x00-\x1f\x7f]/.test(ch)) out += `$([char]${ch.charCodeAt(0)})`;
    else out += ch;
  }
  return `${out}"`;
}

/** Komut adı olarak çıplak yazılabilir mi (Write-Host, iex, foo.exe) */
export const isSimpleName = (s) => typeof s === 'string' && /^[A-Za-z_][\w.-]*(?:\\[A-Za-z_][\w.-]*)?$/.test(s) && !isKeyword(s) && !/[.-]$/.test(s);
export const isIdentifier = (s) => typeof s === 'string' && /^[A-Za-z_]\w*$/.test(s);
export const textOf = (code, n) => code.slice(n.start, n.end);
