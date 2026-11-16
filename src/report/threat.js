// Tehdit analizi: kaynaklar (girdi, açılan katmanlar, çözülmüş çıktı) düzenli ifadelerle taranır. Gizleme açıldıkça
// tehlikeli çağrılar düz metinde görünür; bu yüzden çıktı ve katmanlar asıl kanıttır. Birden çok işaret gerektiren
// sınıflar önce tek tek kaynaklarda, sonra birleşik metinde aranır (indirme bir katmanda, çalıştırma başka katmanda
// olabilir). Şüpheli dizgeler kaynakta parçalı yazılır (antivirüs imzaları).
import { pick, rx, snippet, t, WHERE } from './text.js';

export const CLASSES = {
  'remote-exec': t('Uzaktan indirip çalıştırma (indirme sarmalı + iex)', 'Remote download and execute (download cradle + iex)'),
  downloader: t('Dosya indirici', 'File downloader'),
  'amsi-bypass': t('AMSI atlatma', 'AMSI bypass'),
  'defense-evasion': t('Savunma atlatma (Defender, günlük, ETW, gizli pencere)', 'Defence evasion (Defender, logging, ETW, hidden window)'),
  persistence: t('Kalıcılık (Run anahtarı, zamanlanmış görev, hizmet, WMI, Başlangıç)', 'Persistence (Run key, scheduled task, service, WMI, Startup)'),
  'credential-theft': t('Kimlik bilgisi hırsızlığı', 'Credential theft'),
  'reverse-shell': t('Ters kabuk (TCP üzerinden komut erişimi)', 'Reverse shell (command access over TCP)'),
  injection: t('Bellekte kod yükleme / enjeksiyon', 'In-memory code loading / injection'),
  'privilege-escalation': t('Yetki yükseltme (UAC atlatma, RunAs)', 'Privilege escalation (UAC bypass, RunAs)'),
  destructive: t('Yıkıcı işlem (gölge kopya, yedek, disk silme)', 'Destructive action (shadow copy, backup, disk wipe)'),
  miner: t('Kripto para madencisi', 'Cryptocurrency miner'),
  recon: t('Sistem keşfi', 'System reconnaissance'),
  exfiltration: t('Veri sızdırma (Discord/Telegram/dosya yükleme)', 'Data exfiltration (Discord/Telegram/file upload)'),
};

const IEX = '(?:\\biex\\b|invoke-expression|\\.invokescript\\()';
const FETCH = '(?:downloadstring|downloaddata|openread|invoke-webrequest|\\biwr\\b|invoke-restmethod|\\birm\\b|net\\.webclient|httpclient|xmlhttp|winhttprequest)';

// Tek işaretli kurallar: [sınıf, ağırlık, regex]
export const RULES = [
  ['remote-exec', 80, rx([IEX, '[^\\n]{0,160}', FETCH], 'i')],
  ['remote-exec', 80, rx([FETCH, '[^\\n]{0,240}\\|\\s*(?:iex\\b|invoke-expression)'], 'i')],
  ['downloader', 55, /\.downloadfile\s*\(|(?:invoke-webrequest|\biwr\b|\bwget\b|\bcurl\b)[^\n|;]{0,200}-outf(?:ile)?\b|start-bitstransfer\b|\bbitsadmin\b[^\n]{0,40}\/transfer|\bcertutil\b[^\n]{0,40}-urlcache/i],
  ['amsi-bypass', 85, rx(['amsi', 'utils|amsi', 'initfailed|amsi', 'scanbuffer|amsi', 'context|amsi\\.dll'], 'i')],
  ['defense-evasion', 60, /set-mppreference\b[^\n]{0,80}-disable\w*|add-mppreference\b[^\n]{0,80}-exclusion\w*|disablerealtimemonitoring/i],
  ['defense-evasion', 55, rx(['etw', 'eventwrite|psetwlog', 'provider|scriptblock', 'logging|enablescriptblock', 'invocationlogging'], 'i')],
  ['defense-evasion', 50, /\bclear-eventlog\b|\bwevtutil(?:\.exe)?\s+(?:cl|clear-log)\b|remove-item[^\n]{0,80}consolehost_history/i],
  ['defense-evasion', 35, /(?:^|\s)[-/]w(?:i[a-z]*)?\s+['"]?(?:hidden|1)\b/im],
  ['persistence', 55, /currentversion\\+(?:run|runonce)\b|\\+winlogon\\+(?:userinit|shell)\b/i],
  ['persistence', 55, /\bschtasks(?:\.exe)?\s+\/create\b|register-scheduledtask\b|new-scheduledtask(?:action|trigger)\b/i],
  ['persistence', 55, /\bnew-service\b|\bsc(?:\.exe)?\s+create\b/i],
  ['persistence', 60, /__eventfilter|commandlineeventconsumer|__filtertoconsumerbinding|activescripteventconsumer/i],
  ['persistence', 45, /\\start menu\\programs\\startup|shell:startup|\[environment\]::getfolderpath\(\s*['"]startup['"]/i],
  ['credential-theft', 70, rx(['mimi', 'katz|sekur', 'lsa::|invoke-mimi', 'katz|lsadump::'], 'i')],
  ['credential-theft', 70, rx(['comsvcs(?:\\.dll)?[^\\n]{0,40}mini', 'dump|\\blsa', 'ss\\b[^\\n]{0,60}(?:dump|minidump|procdump)'], 'i')],
  ['credential-theft', 60, /\breg(?:\.exe)?\s+save\s+hklm\\+(?:sam|security|system)\b|\\login data\b|\bvaultcmd\b|get-credential[^\n]{0,80}-message/i],
  ['reverse-shell', 85, rx(['net\\.sockets\\.tcp', 'client[\\s\\S]{0,400}getstream[\\s\\S]{0,800}', IEX], 'i')],
  ['injection', 70, rx(['virtual', 'alloc|createremote', 'thread|writeprocess', 'memory|getdelegatefor', 'functionpointer|ntmapviewof', 'section'], 'i')],
  ['injection', 60, /\[(?:system\.)?reflection\.assembly\]::load(?:file|from)?\s*\(|\.entrypoint\.invoke\s*\(/i],
  ['injection', 45, /add-type\b[^\n]{0,200}(?:dllimport|kernel32)/i],
  ['privilege-escalation', 65, /ms-settings\\+shell\\+open\\+command|mscfile\\+shell\\+open\\+command|\bfodhelper\b|\beventvwr\b|\bcomputerdefaults\b/i],
  ['privilege-escalation', 40, /start-process\b[^\n]{0,120}-verb\s+['"]?runas/i],
  ['destructive', 85, /\bvssadmin(?:\.exe)?\s+delete\s+shadows|win32_shadowcopy[^\n]{0,60}\.delete\(|\bwbadmin(?:\.exe)?\s+delete\b|\bbcdedit(?:\.exe)?[^\n]{0,40}recoveryenabled\s+no/i],
  ['destructive', 80, /\bformat-volume\b|\bclear-disk\b|\bcipher(?:\.exe)?\s+\/w\b|remove-item\s+(?:-\w+\s+)*['"]?[a-z]:\\['"]?\s+(?:-\w+\s+)*-recurse/i],
  ['miner', 75, rx(['\\bstratum\\+', '(?:tcp|ssl|tls)://|\\bxm', 'rig\\b|--donate-level\\b'], 'i')],
  ['exfiltration', 55, rx(['discord(?:app)?\\.com/api/(?:v\\d+/)?', 'webhooks/|api\\.telegram\\.org/', 'bot'], 'i')],
  ['exfiltration', 45, /\.uploadfile\s*\(|\.uploadvalues\s*\(|invoke-restmethod\b[^\n]{0,200}-infile\b/i],
];

// Keşif: tek başına zararsız; en az iki farklı işaret gerekir
const RECON = [/\bwhoami\b/i, /\bsysteminfo\b/i, /\bipconfig\b/i, /\bnet(?:\.exe)?\s+(?:user|localgroup|group)\b/i, /get-wmiobject\s+(?:-class\s+)?win32_|get-ciminstance\s+(?:-classname\s+)?win32_/i,
  /\bget-computerinfo\b/i, /\bnltest\b/i, /\bget-process\b/i, /\bhostname\b/i, /\[environment\]::(?:username|machinename|osversion)/i, /\bget-localuser\b/i];

// Çok işaretli kurallar: [sınıf, [regex...], (eşleşen sayısı) => ağırlık]
const MULTI = [
  ['remote-exec', [rx([FETCH], 'i'), rx([IEX], 'i')], (n) => (n >= 2 ? 70 : 0)],
  ['downloader', [/\.downloaddata\s*\(|\.downloadfile\s*\(|-outfile\b/i, /start-process\b|\binvoke-item\b|\bii\b|\[diagnostics\.process\]::start/i], (n) => (n >= 2 ? 65 : 0)],
];

/**
 * @param {Array} sources text.js sourcesOf çıktısı
 * @param {Array} layers trace.layers (başlatıcı bayrakları)
 */
export function threat(sources, layers = [], lang = 'tr') {
  const findings = [];
  const flagsText = layers.flatMap((l) => l.flags ?? []).join(' ');
  const scan = [...(flagsText ? [{ where: 'behaviour', text: `powershell ${flagsText}` }] : []), ...sources];
  const multi = (src) => {
    for (const [cls, res, weightOf] of MULTI) {
      const hits = res.map((re) => src.text.match(re)?.[0]).filter(Boolean);
      const weight = weightOf(hits.length);
      if (weight) findings.push({ cls, weight, ev: `${pick(WHERE[src.where], lang)}: ${hits.map((h) => snippet(h, 40)).join(' + ')}` });
    }
  };
  for (const src of scan) {
    if (!src.text) continue;
    const text = src.text.length > 4_000_000 ? src.text.slice(0, 4_000_000) : src.text;
    const where = pick(WHERE[src.where], lang);
    for (const [cls, weight, re] of RULES) {
      const m = text.match(re);
      if (m) findings.push({ cls, weight, ev: `${where}: ${snippet(m[0], 80)}` });
    }
    const recon = RECON.map((re) => text.match(re)?.[0]).filter(Boolean);
    if (recon.length >= 2) findings.push({ cls: 'recon', weight: Math.min(30, 10 + recon.length * 5), ev: `${where}: ${recon.slice(0, 5).map((h) => snippet(h, 30)).join(', ')}` });
    multi({ ...src, text });
  }
  // indirme ve çalıştırma farklı katmanlarda olabilir: birleşik metinde yalnızca tek kaynakta bulunmayan sınıflar eklenir
  const single = new Set(findings.map((f) => f.cls));
  const before = findings.length;
  // gizlenmiş girdideki iex çoğunlukla açılan katmanın kendisidir: birleşik metin yalnızca çözülmüş kaynaklardan kurulur
  const decoded = scan.filter((s) => s.where !== 'input');
  multi({ where: 'all', text: (decoded.length ? decoded : scan).map((s) => s.text).join('\n') });
  findings.splice(before, Infinity, ...findings.slice(before).filter((f) => !single.has(f.cls)));

  const byClass = new Map();
  for (const f of findings) {
    const c = byClass.get(f.cls) ?? { id: f.cls, title: pick(CLASSES[f.cls], lang), weight: 0, evidence: [] };
    c.weight = Math.max(c.weight, f.weight);
    const body = f.ev.slice(f.ev.indexOf(': ') + 2);
    if (c.evidence.length < 6 && !c.evidence.some((e) => e.slice(e.indexOf(': ') + 2) === body)) c.evidence.push(f.ev);
    byClass.set(f.cls, c);
  }
  const classes = [...byClass.values()].sort((a, b) => b.weight - a.weight);
  // en güçlü sınıf tam, diğerleri yarım ağırlıkla
  const score = Math.min(100, Math.round(classes.reduce((s, c, i) => s + (i === 0 ? c.weight : c.weight / 2), 0)));
  const level = score === 0 ? 'none' : score < 20 ? 'low' : score < 45 ? 'medium' : score < 70 ? 'high' : 'critical';
  return { score, level, classes };
}
