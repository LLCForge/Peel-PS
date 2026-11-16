// Kaba sözcük birimleri: kodu kod, yorum ve dizge parçalarına ayırır (biçimlendirme, ` temizliği ve imza karşılaştırması
// için). Çift tırnaklı dizgelerin içindeki $( ) alt ifadeleri yeniden kod parçası olarak verilir.
//   kind: 'code' | 'comment' | 'sq' (tek tırnak) | 'dq' (çift tırnak, düz kısım) | 'hsq' | 'hdq' (here-string) | 'bvar' (${...})
import { isSingleQuote, isDoubleQuote, isHereStart } from './ps.js';

const COMMENT_BEFORE = /[\s;|&(){}[\],=]/;

export function segments(code) {
  const out = [];
  const s = code;
  const n = s.length;
  let i = 0;
  // kip yığını: { kind: 'code', depth } (dizge içindeki $( ) için) | { kind: 'dq' | 'hdq', start }
  const stack = [{ kind: 'code', depth: 0, top: true }];
  let segStart = 0;
  const emit = (kind, start, end) => { if (end > start) out.push({ kind, start, end }); };

  while (i < n) {
    const mode = stack[stack.length - 1];
    const c = s[i];
    if (mode.kind === 'code') {
      if (c === '#' && (i === 0 || COMMENT_BEFORE.test(s[i - 1]))) {
        emit('code', segStart, i);
        let j = s.indexOf('\n', i);
        if (j < 0) j = n;
        if (s[j - 1] === '\r') j--;
        emit('comment', i, j);
        i = segStart = j;
        continue;
      }
      if (c === '<' && s[i + 1] === '#') {
        emit('code', segStart, i);
        const j = s.indexOf('#>', i + 2);
        const end = j < 0 ? n : j + 2;
        emit('comment', i, end);
        i = segStart = end;
        continue;
      }
      if (c === '`') { i += 2; continue; }
      if (isHereStart(s, i)) {
        emit('code', segStart, i);
        const dq = isDoubleQuote(s[i + 1]);
        const closer = dq ? isDoubleQuote : isSingleQuote;
        // gövde: ilk satır sonundan, satır başındaki kapanışa kadar
        let j = s.indexOf('\n', i) + 1;
        let end = n;
        for (; j > 0 && j <= n;) {
          let k = j;
          while (s[k] === ' ' || s[k] === '\t') k++;
          if (closer(s[k]) && s[k + 1] === '@') { end = k + 2; break; }
          const nl = s.indexOf('\n', j);
          if (nl < 0) break;
          j = nl + 1;
        }
        emit(dq ? 'hdq' : 'hsq', i, end);
        i = segStart = end;
        continue;
      }
      if (isSingleQuote(c)) {
        emit('code', segStart, i);
        let j = i + 1;
        while (j < n) {
          if (isSingleQuote(s[j])) {
            if (isSingleQuote(s[j + 1])) { j += 2; continue; }
            j++;
            break;
          }
          j++;
        }
        emit('sq', i, Math.min(j, n));
        i = segStart = Math.min(j, n);
        continue;
      }
      if (isDoubleQuote(c)) {
        emit('code', segStart, i);
        stack.push({ kind: 'dq' });
        segStart = i;
        i++;
        continue;
      }
      if (c === '$' && s[i + 1] === '{') {
        emit('code', segStart, i);
        let j = i + 2;
        while (j < n && s[j] !== '}') j += s[j] === '`' ? 2 : 1;
        emit('bvar', i, Math.min(j + 1, n));
        i = segStart = Math.min(j + 1, n);
        continue;
      }
      if (!mode.top) {
        if (c === '(') mode.depth++;
        else if (c === ')') {
          if (mode.depth === 0) {
            // alt ifade bitti: dizgeye dön
            emit('code', segStart, i);
            stack.pop();
            segStart = i;
            i++;
            continue;
          }
          mode.depth--;
        }
      }
      i++;
      continue;
    }
    // çift tırnaklı dizge
    if (c === '`') { i += 2; continue; }
    if (isDoubleQuote(c)) {
      if (isDoubleQuote(s[i + 1])) { i += 2; continue; }
      emit('dq', segStart, i + 1);
      stack.pop();
      i = segStart = i + 1;
      continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      emit('dq', segStart, i + 2);
      stack.push({ kind: 'code', depth: 0, top: false });
      i = segStart = i + 2;
      continue;
    }
    i++;
  }
  const last = stack[stack.length - 1];
  emit(last.kind === 'code' ? 'code' : 'dq', segStart, n);
  return out;
}

/** Biçim farkından bağımsız imza: kod küçük harfli, boşluk/satır sonu/; olmadan; dizge ve yorumlar olduğu gibi */
export function signature(code) {
  let out = '';
  for (const seg of segments(code)) {
    const t = code.slice(seg.start, seg.end);
    if (seg.kind === 'code') out += t.toLowerCase().replace(/[\s;]+|`\r?\n/g, '');
    else if (seg.kind === 'comment') continue;
    else out += `\u0001${t}\u0001`;
  }
  return out;
}
