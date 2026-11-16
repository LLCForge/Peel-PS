// CLI testleri: node test/cli.test.js
// Zararlı koda benzeyen örnekler diske yazılmaz: kodlu fixture bellekte çözülüp stdin'den verilir.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFixture } from './fixture-codec.js';

const BIN = fileURLToPath(new URL('../bin/peel-ps.js', import.meta.url));
const cli = (args, input) => spawnSync(process.execPath, [BIN, ...args], { input, timeout: 240_000 });
const fixture = (name) => decodeFixture(readFileSync(new URL(`./analyze-fixtures/${name}.ps1.x`, import.meta.url), 'utf8'));

const tmp = mkdtempSync(join(tmpdir(), 'peel-ps-cli-'));
try {
  // kullanım ve hata çıkış kodları
  assert.equal(cli(['-h']).status, 0);
  assert.match(cli(['--help', '--lang', 'en']).stdout.toString(), /Exit codes/);
  assert.equal(cli([]).status, 2);
  assert.equal(cli(['x.ps1', '--lang', 'de']).status, 2);
  assert.equal(cli(['x.ps1', '--fail-on', 'none']).status, 2);
  assert.equal(cli(['x.ps1', '--only', 'layers,nope']).status, 2);
  assert.equal(cli(['x.ps1', '--timeout', '0']).status, 2);
  assert.equal(cli(['x.ps1', '--bogus']).status, 2);
  let r = cli([join(tmp, 'yok.ps1'), '--lang', 'en']);
  assert.equal(r.status, 1);
  assert.match(r.stderr.toString(), /File not found/);

  // toplu iş: dizin yapısı korunur, PowerShell dışı dosyalar atlanır, UTF-16LE (BOM) girdi okunur, UTF-8 korunur
  const src = join(tmp, 'src');
  mkdirSync(join(src, 'a', 'b'), { recursive: true });
  writeFileSync(join(src, 'a', 'b', 'x.ps1'), "iex ('Write-Output '+'hi')\n");
  writeFileSync(join(src, 'top.psm1'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("&('Write'+'-Output') 'ü'\n", 'utf16le')]));
  writeFileSync(join(src, 'readme.txt'), 'not a script');
  const out = join(tmp, 'out');
  const rep = join(tmp, 'rep.json');
  r = cli([src, '-d', out, '-r', rep, '-q']);
  assert.equal(r.status, 0, r.stderr.toString());
  assert.equal(readFileSync(join(out, 'a', 'b', 'x.ps1'), 'utf8').trim(), 'Write-Output hi');
  assert.equal(readFileSync(join(out, 'top.psm1'), 'utf8').trim(), "Write-Output 'ü'");
  assert.ok(!existsSync(join(out, 'readme.txt')));
  const reports = JSON.parse(readFileSync(rep, 'utf8'));
  assert.deepEqual(reports.map((e) => e.file), ['a/b/x.ps1', 'top.psm1']);
  assert.ok(reports.every((e) => e.ok && e.verified && e.report.threat.level === 'none'));
  assert.ok(reports[0].report.detection.some((d) => d.id === 'iex-chain'));
  assert.equal(cli([src, '-o', join(tmp, 'x.ps1')]).status, 2);

  // tek dosya: çözülmüş kod stdout'a, -o ile dosyaya; --only ve --no-format
  const one = join(src, 'a', 'b', 'x.ps1');
  r = cli([one, '-q']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.toString().trim(), 'Write-Output hi');
  r = cli([one, '-o', join(tmp, 'one.ps1'), '-q']);
  assert.equal(r.status, 0);
  assert.equal(readFileSync(join(tmp, 'one.ps1'), 'utf8').trim(), 'Write-Output hi');
  r = cli([one, '--only', 'fold', '-q']);
  assert.equal(r.status, 0);
  assert.match(r.stdout.toString(), /^iex 'Write-Output hi'/);
  assert.equal(cli(['-', '--no-format', '-q'], 'wRiTe-OuTpUt   a ;  echo b\n').stdout.toString(), 'wRiTe-OuTpUt   a ;  echo b\n');
  assert.equal(cli(['-', '-q'], 'wRiTe-OuTpUt   a ;  echo b\n').stdout.toString(), 'Write-Output a\necho b\n');

  // metin rapor: stdout'a ve .txt dosyasına
  r = cli([one, '-r', 'text', '--lang', 'en']);
  assert.equal(r.status, 0);
  assert.match(r.stdout.toString(), /^Summary: .*\nThreat: none \(0\/100\)/);
  r = cli([one, '-r', join(tmp, 'rep.txt'), '-q']);
  assert.equal(r.status, 0);
  assert.match(readFileSync(join(tmp, 'rep.txt'), 'utf8'), /^Özet: /);

  // stdin + --json + --fail-on: eşik aşılınca çıkış kodu 4, rapor İngilizce
  r = cli(['-', '--json', '--fail-on', 'high', '--lang', 'en'], fixture('dropper'));
  assert.equal(r.status, 4, r.stderr.toString());
  const j = JSON.parse(r.stdout.toString());
  assert.equal(j.file, '-');
  assert.equal(j.report.threat.level, 'critical');
  assert.ok(j.report.threat.classes.some((c) => c.id === 'remote-exec'));
  assert.match(j.report.summary, /Threat level critical/);
  r = cli(['-', '-r', 'text', '--lang', 'en'], fixture('wiper'));
  assert.equal(r.status, 0);
  assert.match(r.stdout.toString(), /Destructive action/);
  assert.equal(cli(['-', '--fail-on', 'low', '-q'], "Write-Output 'merhaba'\n").status, 0);

  // PE ikilisi: koruma raporlanır, -o baytları olduğu gibi yazar (UTF-8 çözümüyle bozulmaz)
  const exe = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0xff, 0xfe]), Buffer.from('PS2EXEHost\0')]);
  r = cli(['-', '--json', '--lang', 'en', '-o', join(tmp, 'a.exe')], exe);
  assert.equal(JSON.parse(r.stdout.toString()).report.protection.product, 'PS2EXE');
  assert.deepEqual(readFileSync(join(tmp, 'a.exe')), exe);
  // ayrıştırılamayan kısımlar: çıkış 0, verified false
  r = cli(['-', '--json', '--lang', 'en'], "Write-Output 'a'\n$x = ('kapanmamış\n");
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout.toString()).verified, false);
  console.log('cli: ok');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
