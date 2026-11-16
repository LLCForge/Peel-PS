// peel-ps komut satırı: tarayıcıdakiyle aynı hat, yalıtılmış alt süreçte (Node izin modeli) ve bekçiyle.
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, basename } from 'node:path';
import { peel, passes } from '../index.js';
import { createNodeSandbox } from '../sandbox/node-host.js';
import { reportText } from '../report/text.js';
import { parseArgs, UsageError } from './args.js';

export const EXIT = { OK: 0, ERROR: 1, USAGE: 2, THREAT: 4 };
export const MAX_INPUT = 16 * 1024 * 1024;
const LEVELS = ['none', 'low', 'medium', 'high', 'critical'];
const PS_FILE = /\.(?:ps1|psm1|psd1)$/i;

const SPEC = {
  out: { alias: 'o', type: 'string' },
  'out-dir': { alias: 'd', type: 'string' },
  report: { alias: 'r', type: 'string' },
  json: { type: 'bool' },
  lang: { type: 'string' },
  only: { type: 'list' },
  format: { type: 'bool' },
  timeout: { type: 'number' },
  'fail-on': { type: 'string' },
  quiet: { alias: 'q', type: 'bool' },
  help: { alias: 'h', type: 'bool' },
};

const HELP = {
  tr: `peel-ps <dosya|dizin|-> [seçenekler]

Gizlenmiş PowerShell betiklerini (Invoke-Obfuscation, -EncodedCommand, iex katmanları, sıkıştırma, SecureString ...)
statik olarak açar ve analiz raporu üretir. Betik hiçbir zaman çalıştırılmaz.

  -o, --out <dosya>        çözülmüş kodu dosyaya yaz (tek girdi; yoksa stdout)
  -d, --out-dir <dizin>    çözülmüş kodları dizine yaz (dizin girdisinde yapı korunur)
  -r, --report <hedef>     rapor: json | text (stdout'a, kod yazılmaz) ya da dosya yolu (.txt ise metin, değilse JSON;
                           dizin girdisinde JSON dizi)
      --json               --report json ile aynı
      --only <geçiş,...>   yalnızca bu geçişler (${passes().map((p) => p.id).join(', ')})
      --no-format          çıktıyı biçimlendirme
      --timeout <sn>       dosya başına süre bütçesi (varsayılan 30)
      --lang tr|en         rapor dili (varsayılan tr)
      --fail-on <düzey>    tehdit düzeyi bu eşiğe ulaşırsa çıkış kodu 4: low | medium | high | critical
  -q, --quiet              ilerleme ve özet yazma
  -h, --help               bu yardım

Dizin girdisinde .ps1, .psm1 ve .psd1 dosyaları işlenir. Girdi en fazla ${MAX_INPUT / 1024 / 1024} MB.
Çıkış kodları: 0 tamam, 1 hata, 2 kullanım hatası, 4 --fail-on eşiğine ulaşıldı (hatadan önceliklidir).
PS2EXE ile derlenmiş ikililer tanınır ama çözülmez.`,
  en: `peel-ps <file|dir|-> [options]

Statically unwraps obfuscated PowerShell (Invoke-Obfuscation, -EncodedCommand, iex layers, compression, SecureString ...)
and produces an analysis report. The script is never executed.

  -o, --out <file>         write the decoded code to a file (single input; otherwise stdout)
  -d, --out-dir <dir>      write decoded files to a directory (directory input keeps its structure)
  -r, --report <target>    report: json | text (to stdout, no code) or a file path (.txt gives text, anything else JSON;
                           a JSON array for directory input)
      --json               same as --report json
      --only <pass,...>    run only these passes (${passes().map((p) => p.id).join(', ')})
      --no-format          do not format the output
      --timeout <s>        time budget per file (default 30)
      --lang tr|en         report language (default tr)
      --fail-on <level>    exit with code 4 when the threat level reaches: low | medium | high | critical
  -q, --quiet              no progress or summary output
  -h, --help               this help

Directory input processes .ps1, .psm1 and .psd1 files. Input is limited to ${MAX_INPUT / 1024 / 1024} MB.
Exit codes: 0 ok, 1 error, 2 usage error, 4 --fail-on threshold reached (takes precedence over errors).
PS2EXE-compiled binaries are identified but not decoded.`,
};

// çözme hattının Türkçe hata iletileri (src/core) EN raporda çevrilir
const ERRORS_EN = {
  'Kod ayrıştırılamadı (PowerShell sözdizimi hatası)': 'Could not parse the code (PowerShell syntax error)',
  Durduruldu: 'Stopped',
  'Girdi çok büyük': 'Input too large',
};
const errText = (msg, lang) => (lang === 'en'
  ? (ERRORS_EN[msg] ?? msg.replace(/^Dosya çok büyük: /, 'File too large: ').replace(/^Dosya değil: /, 'Not a file: ').replace(/^Dosya bulunamadı: /, 'File not found: ').replace(/^zaman aşımı: .*/, 'timeout: the decoder did not answer in time and was restarted (watchdog)'))
  : msg);

async function readBytes(path) {
  if (path === '-') {
    const chunks = [];
    let n = 0;
    for await (const c of process.stdin) {
      n += c.length;
      if (n > MAX_INPUT) throw new Error('Girdi çok büyük');
      chunks.push(c);
    }
    return new Uint8Array(Buffer.concat(chunks));
  }
  const s = await stat(path);
  if (!s.isFile()) throw new Error(`Dosya değil: ${path}`);
  if (s.size > MAX_INPUT) throw new Error(`Dosya çok büyük: ${path}`);
  return new Uint8Array(await readFile(path));
}

/** Dizindeki PowerShell dosyaları (özyinelemeli, sembolik bağlar izlenmez), sıralı */
async function listScripts(root) {
  const out = [];
  const walkDir = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walkDir(p);
      else if (e.isFile() && PS_FILE.test(e.name)) out.push(p);
    }
  };
  await walkDir(root);
  return out;
}

async function writeOut(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

const levelOf = (entry) => entry.report?.threat?.level ?? 'none';
const textOf = (entries, isDir, lang) => entries.map((e) => `${isDir ? `== ${e.file} ==\n` : ''}${e.error ? `${lang === 'en' ? 'Error' : 'Hata'}: ${e.error}\n` : ''}${e.report ? reportText(e.report, lang) : ''}`).join('\n');

export async function runCli(argv) {
  const { opts, positional } = parseArgs(argv, SPEC);
  const lang = opts.lang === undefined ? 'tr' : opts.lang;
  if (lang !== 'tr' && lang !== 'en') throw new UsageError(`--lang tr ya da en olmalı: ${lang}`);
  if (opts.help) { console.log(HELP[lang]); return EXIT.OK; }
  if (positional.length !== 1) throw new UsageError(`${HELP[lang]}\n\n${lang === 'en' ? 'Exactly one input is required (file, directory or -).' : 'Tek bir girdi gerekli (dosya, dizin ya da -).'}`);
  if (opts['fail-on'] !== undefined && !LEVELS.slice(1).includes(opts['fail-on'])) throw new UsageError('--fail-on şunlardan biri olmalı: low, medium, high, critical');
  if (opts.timeout !== undefined && !(opts.timeout > 0 && opts.timeout <= 600)) throw new UsageError('--timeout 0 ile 600 saniye arasında olmalı');
  const ids = passes().map((p) => p.id);
  const only = opts.only.flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean);
  const unknown = only.filter((x) => !ids.includes(x));
  if (unknown.length) throw new UsageError(`Bilinmeyen geçiş: ${unknown.join(', ')} (geçerli: ${ids.join(', ')})`);
  // -r json|text rapor biçimini stdout'a, başka değer dosya yolunu seçer
  const stdoutReport = opts.json ? 'json' : ['json', 'text'].includes(opts.report) ? opts.report : null;
  const reportFile = opts.report !== undefined && !['json', 'text'].includes(opts.report) ? opts.report : null;

  const target = positional[0];
  const isDir = target !== '-' && (await stat(target).catch(() => null))?.isDirectory();
  if (isDir && opts.out) throw new UsageError('Dizin girdisinde -o yerine -d kullanın');
  const log = (m) => { if (!opts.quiet) process.stderr.write(`${m}\n`); };
  const options = { lang, ...(only.length ? { only } : {}), ...(opts.format === false ? { formatOutput: false } : {}), ...(opts.timeout ? { timeoutMs: opts.timeout * 1000 } : {}) };

  const sandbox = createNodeSandbox();
  const entries = [];
  try {
    const files = isDir ? await listScripts(target) : [target];
    if (isDir && !files.length) log(lang === 'en' ? 'No PowerShell files found.' : 'PowerShell dosyası bulunamadı.');
    for (const file of files) {
      const name = file === '-' ? '-' : isDir ? relative(target, file).split('\\').join('/') : file;
      const entry = { file: name, ok: false };
      entries.push(entry);
      let bytes;
      try {
        bytes = await readBytes(file);
      } catch (e) {
        entry.error = errText(e.code === 'ENOENT' ? `Dosya bulunamadı: ${file}` : e.message, lang);
        log(`${name}: ${entry.error}`);
        continue;
      }
      const r = await peel(bytes, { sandbox, ...options });
      const error = r.error ? errText(r.error, lang) : undefined;
      Object.assign(entry, { ok: !r.error, error, verified: Boolean(r.verified), partial: Boolean(r.partial), ms: r.ms ?? 0, report: r.report });
      // çözülemeyen ya da derlenmiş girdi (ikili, sözdizimi hatası) bayt bayt korunur; çözülen kod UTF-8 yazılır
      const data = r.error || r.report.protection ? Buffer.from(bytes) : Buffer.from(r.code, 'utf8');
      if (opts['out-dir']) {
        const rel = isDir ? relative(target, file) : file === '-' ? 'stdin.ps1' : basename(file);
        const dest = resolve(opts['out-dir'], rel);
        if (relative(resolve(opts['out-dir']), dest).startsWith('..')) throw new Error(`Çıktı dizini dışına yazma: ${rel}`);
        await writeOut(dest, data);
      }
      if (opts.out) await writeOut(opts.out, data);
      else if (!isDir && !opts['out-dir'] && !stdoutReport) process.stdout.write(data);
      const th = r.report.threat;
      log(`${isDir ? `${name}: ` : ''}[${th.level} ${th.score}/100]${error ? ` ${error};` : ''} ${r.report.summary}`);
    }
  } finally {
    sandbox.close();
  }

  const payload = isDir ? entries : entries[0];
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  if (reportFile) await writeOut(reportFile, /\.txt$/i.test(reportFile) ? textOf(entries, isDir, lang) : json);
  if (stdoutReport === 'json') process.stdout.write(json);
  else if (stdoutReport === 'text') process.stdout.write(textOf(entries, isDir, lang));

  const failOn = opts['fail-on'];
  if (failOn && entries.some((e) => LEVELS.indexOf(levelOf(e)) >= LEVELS.indexOf(failOn))) return EXIT.THREAT;
  return entries.some((e) => !e.ok) ? EXIT.ERROR : EXIT.OK;
}
