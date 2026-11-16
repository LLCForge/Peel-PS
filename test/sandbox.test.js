// Yalıtım ve sınır öz-denetimi: node test/sandbox.test.js
// Betik hiçbir zaman çalıştırılmaz; yine de hat Node'da izin modeliyle kısıtlı alt süreçte, bekçiyle çalışır. Bu test
// alt sürecin diske yazamadığını, ağa ve alt sürece erişemediğini, bekçinin kilitlenen motoru öldürüp yenisini
// başlattığını ve değerlendiricinin boyut/süre sınırlarını denetler.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeSandbox, SANDBOX_ARGS } from '../src/sandbox/node-host.js';
import { createWatchdog } from '../src/sandbox/watchdog.js';
import { deobfuscate } from '../src/core/pipeline.js';

// 1. izin modeli: alt süreç bayraklarıyla dosya yazma, süreç başlatma ve dosya okuma (izin dışı) reddedilir
const canary = join(tmpdir(), `peel-ps-escape-${process.pid}.txt`);
const probe = (code) => spawnSync(process.execPath, [...SANDBOX_ARGS, '-e', code], { encoding: 'utf8' });
let p = probe(`require('fs').writeFileSync(${JSON.stringify(canary)}, 'x')`);
assert.notEqual(p.status, 0);
assert.match(p.stderr, /ERR_ACCESS_DENIED/);
assert.equal(existsSync(canary), false, 'yalıtılmış süreç diske yazmamalı');
p = probe("require('child_process').execSync('echo x')");
assert.match(p.stderr, /ERR_ACCESS_DENIED/);
p = probe(`require('fs').readFileSync(${JSON.stringify(join(tmpdir(), 'x'))})`);
assert.match(p.stderr, /ERR_ACCESS_DENIED/);

// 2. yalıtılmış çözücü: sonuç, günlük, ara adımlar
const sb = createNodeSandbox();
try {
  const r = await sb.peel({ input: "iex ('Write-Output '+'hi')", lang: 'en' });
  assert.equal(r.ok, true);
  assert.equal(r.result.code.trim(), 'Write-Output hi');
  assert.ok(r.logs.some(([m]) => /layers: 1/.test(m)));
  assert.ok(r.snapshots.length >= 1);
  assert.equal(r.result.report.metrics.layers, 1);
  // Durdur: uçuştaki iş hata alır, sonraki istek yeni süreçte çalışır
  const pending = sb.peel({ input: 'Write-Output 1' });
  sb.kill('Durduruldu');
  assert.equal((await pending).ok, false);
  assert.equal((await sb.peel({ input: "Write-Output ('a'+'b')" })).result.code.trim(), "Write-Output 'ab'");
} finally {
  sb.close();
}

// 3. bekçi: yanıt vermeyen motor son tarihte öldürülür, kuyruktaki iş yeni motorda sürer
let spawned = 0;
const dog = createWatchdog({
  deadline: () => 200,
  spawn() {
    spawned++;
    const n = spawned;
    let cb = () => {};
    return {
      post: (m) => { if (n > 1 || m.hang !== true) setTimeout(() => cb({ id: m.id, ok: true, n }), 5); },
      onMessage: (f) => { cb = f; },
      onError: () => {},
      terminate: () => {},
    };
  },
});
const [hung, next] = await Promise.all([dog.send({ hang: true }), dog.send({ hang: false })]);
assert.equal(hung.ok, false);
assert.equal(hung.timedOut, true);
assert.equal(next.ok, true);
assert.equal(dog.stats.timeouts, 1);
dog.terminate();

// 4. sınırlar: felaket düzenli ifade değerlendirilmez, dev aralık/dizge/açma bombası kısıtlıdır, bütçe kısmi sonuç verir
let r = await deobfuscate(`$x = ('a' * 40 + '!') -replace '(a+)+$', 'x'`, { budget: { ms: 3000 } });
assert.match(r.code, /-replace/);
r = await deobfuscate("$r = 1..100000000; $s = 'x' * 100000000; Write-Output 'ok'");
assert.match(r.code, /1\.\.100000000/);
assert.match(r.code, /'x' \* 100000000/);
const bomb = Buffer.from(new Uint8Array(1)).toString('base64');
r = await deobfuscate(`[IO.MemoryStream]::new([Convert]::FromBase64String('${bomb}'))`);
assert.ok(!r.error);
r = await deobfuscate("$a = 1..200000 | % { $_ * 2 } | % { $_ + 1 }", { budget: { ms: 1, steps: 1000 } });
assert.equal(r.partial, true);
assert.ok(r.code.includes('$a'));
r = await deobfuscate('x'.repeat(17 * 1024 * 1024));
assert.equal(r.error, 'Girdi çok büyük');
console.log('sandbox öz-denetimi: ok');
