// Ayrıştırıcı, statik değerlendirici, biçimlendirici ve başlatıcı yardımcıları: node test/ps.test.js
import assert from 'node:assert/strict';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { parse, walk, psQuote } from '../src/core/ps.js';
import { analyzeScope } from '../src/core/scope.js';
import { createBudget } from '../src/core/budget.js';
import { literal, toStr } from '../src/core/values.js';
import { format, layout } from '../src/core/format.js';
import { signature, segments } from '../src/core/lex.js';
import { argv } from '../src/passes/launcher.js';
import { base64Decode, base64Encode, decodeText, encodeText, inflateRaw, gunzip, CodecError } from '../src/core/codec.js';
import { deobfuscate } from '../src/core/pipeline.js';

// ── ayrıştırıcı ──
const clean = [
  "Write-Host 'hi'",
  '$a = 1; $b = $a + 2',
  'if ($x -eq 1) { a } elseif ($y) { b } else { c }',
  'foreach ($i in 1..3) { Write-Output $i }',
  'for ($i = 0; $i -lt 3; $i++) { $i }',
  'do { $i-- } until ($i -le 0)',
  'while ($true) { break }',
  'switch -regex ($x) { "^a" { 1 } default { 2 } }',
  'try { 1 } catch [System.Exception] { 2 } finally { 3 }',
  'function Get-Foo([string]$s) { param() process { $s } }',
  '@"\nhere $x\n"@ | Out-Null',
  "@'\nliteral 'quoted'\n'@",
  '$h = @{ a = 1; "b c" = \'x\' }; Invoke-WebRequest @h -OutFile x.txt 2>&1 | Out-Null',
  '[char[]](72,105) -join \'\'',
  "-join ('72R105'-split'R'|%{[char]$_})",
  '${e`Nv:ComSpec}; "${x}y"; $env:TEMP',
  'powershell -nop -w hidden -enc ZQBjAGgAbwA=',
  '$x.(\'Down\'+\'loadString\').Invoke(\'u\')',
  "[Convert]::FromBase64String('AA==')",
  '$a,$b = 1,2',
  "(gv '*mdr*').Name[3,11,2]-join''",
  '$r[-1..-($r.Length)] -join \'\'',
  'class Foo { [string]$Name }',
  '& { param($a) $a } 1',
  '. ($x) | % { $_ }',
  'New-Object IO.StreamReader($x, [Text.Encoding]::ASCII)',
  '$x = -$y + +$()',
  'Get-Process | Where-Object { $_.CPU -gt 1 } | Select-Object -First 1',
  '"a`tb`$c ""d"""',
];
for (const c of clean) assert.equal(parse(c).errors, 0, `ayrıştırılamadı: ${c}`);

// bozuk deyim Raw olur, ayrıştırma sürer
const broken = parse("Write-Host 'a'\n$x = ('unterminated\nWrite-Host 'b'");
assert.ok(broken.errors > 0);
assert.ok(broken.ast.body.stmts.some((s) => s.type === 'Raw'));

// komut ve ifade kipi: -f işleç, -Name parametre, bitişik parantez ayrı argüman
let { ast } = parse("New-Object Net.Sockets.TCPClient('h', 1)");
const cmd = ast.body.stmts[0].elements[0];
assert.equal(cmd.type, 'Command');
assert.deepEqual(cmd.args.map((a) => a.type), ['Bareword', 'Paren']);
({ ast } = parse('"{0}" -f 1'));
assert.equal(ast.body.stmts[0].elements[0].op, '-f');

// çok uzun birleştirme zinciri ve derin iç içe yapı yığını taşırmaz
const chain = Array.from({ length: 20000 }, (_, i) => `'${i % 10}'`).join('+');
const big = parse(`$x = ${chain}`);
assert.equal(big.errors, 0);
const deep = parse(`${'('.repeat(5000)}1${')'.repeat(5000)}`);
assert.ok(deep.errors > 0, 'derinlik sınırı Raw üretmeli');

// ── statik değerlendirici ──
function value(code) {
  const { ast: a } = parse(code);
  const sc = analyzeScope(a, createBudget(), code);
  const r = sc.evaluator.tryEval(a.body.stmts.at(-1));
  return r.ok ? r.value : undefined;
}
const v = (code) => { const x = value(code); return x === undefined ? undefined : literal(x) ?? toStr(x); };
assert.equal(v(`"{1}{0}{2}" -f'e-H','Writ','ost'`), "'Write-Host'");
assert.equal(v(`$ShellId[1]+$ShellId[13]+'x'`), "'iex'");
assert.equal(v(`$env:ComSpec[4,15,25]-Join''`), "'Iex'");
assert.equal(v(`$PSHome[21]+$PSHome[30]+'x'`), "'iex'");
assert.equal(v(`(gv '*mdr*').Name[3,11,2]-join''`), "'iex'");
assert.equal(v(`$VerbosePreference.ToString()[1,3]+'x'-join''`), "'iex'");
assert.equal(v(`$env:Public[13]+$env:Public[5]+'x'`), "'iex'");
assert.equal(v(`(Get-Command *ke-E*n).Name`), "'Invoke-Expression'");
assert.equal(v(`"$(@{})"[14]`), "'i'");
assert.equal(v(`"$?"[1]`), "'r'");
assert.equal(v(`''.Insert`), 'string Insert(int startIndex, string value)');
assert.equal(v(`-join ('87R114'-split'R'|%{[char][int]$_})`), "'Wr'");
assert.equal(v(`('48;65' -split ';' |%{[char]([convert]::ToInt16($_,16))})-join''`), "'He'");
assert.equal(v(`[Convert]::ToInt16('101', 2) + [Convert]::ToInt16('17', 8)`), '20');
assert.equal(v(`[char]([int]'0x2a' -bxor '0x4B')`), "'a'");
assert.equal(v(`[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('ZQBjAGgAbwA='))`), "'echo'");
assert.equal(v(`('abc{0}def' -f [char]39).Replace('def','X')`), "'abc''X'");
assert.equal(v(`'a1b2' -replace '(\\d)', '<$1>'`), "'a<1>b<2>'");
assert.equal(v(`'AbA' -creplace 'A', 'x'`), "'xbx'");
assert.equal(v(`'AbA' -replace 'a', 'x'`), "'xbx'");
assert.equal(v(`'a,b,c'.Split(',') -join '|'`), "'a|b|c'");
// çok karakterli Split: Windows PowerShell'de karakter kümesi, PowerShell 7'de dizge ayırıcı; belirsiz, katlanmaz
assert.equal(v(`'a,b;c'.Split(',;') -join '|'`), undefined);
assert.equal(v(`([regex]::Matches('olleh','.','RightToLeft') | ForEach-Object {$_.Value}) -join ''`), "'hello'");
assert.equal(v(`$a = 'tsoH-etirW'; $a[-1..-($a.Length)] -join ''`), "'Write-Host'");
assert.equal(v(`$c = 'cba'.ToCharArray(); [Array]::Reverse($c); -join $c`), "'abc'");
assert.equal(v(`'ab' * 3`), "'ababab'");
assert.equal(v(`[char]65 + [char]66`), "'AB'");
assert.equal(v(`1 + '2'`), '3');
assert.equal(v(`'1' + 2`), "'12'");
assert.equal(v(`"{0:X2}|{1,4}|{0:D4}" -f 10,'ab'`), "'0A|  ab|0010'");
assert.equal(v(`[string]::Join('-', @(1, 2, 3))`), "'1-2-3'");
assert.equal(v(`[ScriptBlock]::Create('Write-Host 1')`), '{Write-Host 1}');
assert.equal(v(`[type]('Net.'+'WebClient')`), '[Net.WebClient]');
assert.equal(v(`1..3 | % { $_ * 2 }`), '@(2, 4, 6)');
assert.equal(v(`'a','b','c' | Where-Object { $_ -ne 'b' }`), "@('a', 'c')");
assert.equal(v(`$x = 1; $x += 2; $x`), '3');
assert.equal(v(`$p = 'a'; $p = $p + 'b'; $p`), "'ab'");
const deflated = deflateRawSync(Buffer.from('Write-Output 1')).toString('base64');
assert.equal(v(`(New-Object IO.StreamReader((New-Object IO.Compression.DeflateStream([IO.MemoryStream][Convert]::FromBase64String('${deflated}'),[IO.Compression.CompressionMode]::Decompress)),[Text.Encoding]::ASCII)).ReadToEnd()`), "'Write-Output 1'");
const gz = gzipSync(Buffer.from('ü')).toString('base64');
assert.equal(v(`$m = [IO.MemoryStream]::new([Convert]::FromBase64String('${gz}')); (New-Object IO.StreamReader(New-Object IO.Compression.GZipStream($m, [IO.Compression.CompressionMode]::Decompress))).ReadToEnd()`), "'ü'");
// statik olmayanlar: komut, ağ, ortam, girdi, -match ($Matches yan etkisi)
for (const c of ['Get-Date', '(New-Object Net.WebClient).DownloadString("x")', '$env:TEMP', 'Read-Host', "'a' -match 'a'", '$x', '[IO.File]::ReadAllText("a")', "'x' | Out-File a.txt"]) {
  assert.equal(value(c), undefined, `statik değerlendirilmemeli: ${c}`);
}
// döngüde değişen değişken iç blokta sabit sayılmaz
assert.equal(v(`$x = 'a'; foreach ($i in 1..2) { $x += 'b' }; $x`), undefined);

// ── kodlamalar ──
assert.deepEqual([...base64Decode(' aGk= ')], [104, 105]);
assert.throws(() => base64Decode('aGk'), CodecError);
assert.equal(base64Encode(new Uint8Array([104, 105])), 'aGk=');
assert.equal(decodeText(encodeText('ğü', 'Unicode'), 'Unicode'), 'ğü');
assert.equal(decodeText(new Uint8Array([104, 200]), 'ASCII'), 'h?');
assert.equal(decodeText(new Uint8Array([0xe7]), 'Default'), 'ç');
assert.deepEqual(inflateRaw(deflateRawSync(Buffer.from('abc'))), new Uint8Array(Buffer.from('abc')));
assert.deepEqual(gunzip(gzipSync(Buffer.from('abc'))), new Uint8Array(Buffer.from('abc')));
assert.throws(() => inflateRaw(deflateRawSync(Buffer.alloc(100_000)), 1000), CodecError, 'sıkıştırma bombası sınırı');

// ── dizge değişmezi ──
assert.equal(psQuote("it's"), "'it''s'");
assert.equal(psQuote('a\u0000b'), '"a`0b"');
assert.equal(psQuote('$x\t'), "'$x\t'");
assert.equal(psQuote('$x\u0007'), '"`$x`a"');

// ── biçimlendirme ──
assert.equal(layout('if($x){a;b}else{c}'), 'if ($x) {\n    a\n    b\n} else {c}\n');
assert.equal(layout("do{ $i++ ; $j++ }\nwhile($i -lt 3)"), 'do {\n    $i++\n    $j++\n} while ($i -lt 3)\n');
assert.equal(layout("$h = @{a=1;b=2}; for($i=0;$i -lt 2;$i++){x}"), '$h = @{a=1;b=2}\nfor ($i=0;$i -lt 2;$i++) {x}\n');
assert.equal(layout("@'\n  keep;  this\n'@"), "@'\n  keep;  this\n'@\n");
assert.equal(format('wRiTe-HoSt ( \'X\' ) -FOREGROUNDCOLOR red'), "Write-Host ('X') -ForegroundColor red\n");
assert.equal(format("$Abc = 1; $aBC + $ABC -JOIN ''"), "$Abc = 1\n$Abc + $Abc -join ''\n");
assert.equal(format("[sYsTeM.tExT.eNcOdInG]::uTf8.gEtStRiNg($b)"), '[System.Text.Encoding]::UTF8.GetString($b)\n');
assert.equal(signature("A ;B 'x  y'"), signature("a\nb 'x  y'"));
assert.notEqual(signature("a 'x'"), signature("a 'X'"));
assert.ok(segments('"a $(b "c") d" # e').some((s) => s.kind === 'code' && s.end - s.start === 1));

// ── başlatıcı komut satırı (CommandLineToArgvW) ──
assert.deepEqual(argv('a "b c" d\\"e "f\\\\" g""h'), ['a', 'b c', 'd"e', 'f\\', 'gh']);
assert.deepEqual(argv('-c "Write-Host \\"x\\""'), ['-c', 'Write-Host "x"']);

// ── hat: bütçe ve katman sınırı ──
const src = Array.from({ length: 300 }, (_, i) => `iex 'Write-Output ${i}'`).join('\n');
const r = await deobfuscate(src);
assert.ok(r.partial, 'katman sınırı kısmi sonuç vermeli');
assert.ok(r.trace.layers.length <= 256);
const slow = await deobfuscate(`$x = 1..900000 | % { $_ }; $y = ('a' * 1000000) * 10`, { budget: { ms: 200 } });
assert.ok(!slow.error);
console.log(`ps: ${clean.length} ayrıştırma, değerlendirici, kodlamalar, biçimlendirme, argv, sınırlar: ok`);
