// Rapor testleri: node test/analyze.test.js
// Zararlı betiklere benzeyen örnekler diskte kodlu durur (test/analyze-fixtures/*.ps1.x), yalnızca bellekte çözülür.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { peel, analyze } from '../src/index.js';
import { reportText } from '../src/report/text.js';
import { readability } from '../src/report/readability.js';
import { decodeFixture } from './fixture-codec.js';

const load = (name) => decodeFixture(readFileSync(new URL(`./analyze-fixtures/${name}.ps1.x`, import.meta.url), 'utf8')).toString('utf8');
const run = async (name, lang = 'en') => (await peel(load(name), { lang })).report;
const classes = (r) => r.threat.classes.map((c) => c.id);
const detected = (r) => r.detection.map((d) => d.id);

// indir-çalıştır: -EncodedCommand açılır, sarmal ve IP bulunur
let r = await run('dropper');
assert.equal(r.threat.level, 'critical');
assert.ok(classes(r).includes('remote-exec'));
assert.deepEqual(r.iocs.ips, ['198.51.100.7']);
assert.deepEqual(r.iocs.urls, ['http://198.51.100.7/stage2.ps1']);
assert.equal(r.iocs.cradles.length, 1);
assert.ok(detected(r).includes('encodedcommand') && detected(r).includes('launcher-flags'));
assert.deepEqual(r.layers.map((l) => l.kind), ['encodedcommand']);
assert.ok(r.layers[0].flags.includes('-w hidden'));
assert.equal(r.behaviour.network[0].target, 'http://198.51.100.7/stage2.ps1');
assert.ok(r.metrics.readability.output > r.metrics.readability.input);

// AMSI atlatma: birleştirmeyle gizlenmiş ad katlanınca görünür
r = await run('amsi');
assert.ok(classes(r).includes('amsi-bypass'));
assert.ok(r.iocs.amsi.length >= 1);

// kalıcılık
r = await run('persistence');
assert.ok(classes(r).includes('persistence'));
assert.ok(r.iocs.persistence.some((p) => /CurrentVersion\\Run/.test(p)));
assert.ok(r.iocs.persistence.some((p) => /schtasks \/create/.test(p)));
assert.ok(r.behaviour.commands.some((c) => c.api === 'schtasks'));

// ters kabuk: sıkıştırma katmanı açılır, TCP hedefi bulunur
r = await run('revshell');
assert.ok(classes(r).includes('reverse-shell'));
assert.ok(detected(r).includes('invoke-obfuscation') && detected(r).includes('compression'));
assert.deepEqual(r.iocs.ips, ['203.0.113.9']);
assert.ok(r.behaviour.network.some((n) => n.target === '203.0.113.9:4444'));

// kimlik hırsızlığı + Discord webhook sızdırma
r = await run('stealer');
assert.ok(classes(r).includes('credential-theft') && classes(r).includes('exfiltration'));
assert.ok(!classes(r).includes('remote-exec'), 'açılan iex katmanı indir-çalıştır sayılmamalı');
assert.equal(r.iocs.discordWebhooks.length, 1);

// yıkıcı (XOR çözülür) ve madenci (ters dizge)
r = await run('wiper');
assert.ok(classes(r).includes('destructive'));
assert.ok(detected(r).includes('bxor'));
r = await run('miner');
assert.ok(classes(r).includes('miner'));
assert.ok(detected(r).includes('invoke-obfuscation'));

// zararsız: tehdit yok, özet Türkçe
const tr = await run('benign', 'tr');
assert.equal(tr.threat.level, 'none');
assert.match(tr.summary, /tehdit düzeyi yok/);
assert.equal(tr.lang, 'tr');

// derlenmiş betik: PS2EXE tanınır, çözülmez
const exe = `MZ\u0090\u0000${'\u0000'.repeat(60)}PS2EXEHost`;
const p = analyze({ input: exe, output: exe, lang: 'en' });
assert.equal(p.protection.product, 'PS2EXE');
assert.equal(p.threat.level, 'none');
assert.match(p.summary, /compiled with PS2EXE/);

// düz metin rapor
const text = reportText(await run('dropper'), 'en');
assert.match(text, /^Summary: /);
assert.match(text, /Unwrapped layers:\n {2}- encodedcommand/);
assert.match(text, /readability \d+ → \d+\/100/);

// okunabilirlik: gizlenmiş < düz
assert.ok(readability("&(\"{1}{0}\" -f 'ost','Write-H') ('h'+'i')") < readability("Write-Host 'hi'"));
assert.equal(readability(''), 100);
console.log('analyze: ok');
