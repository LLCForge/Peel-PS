// IOC çıkarımı: URL, alan adı, IP, e-posta, Discord webhook, Telegram bot token/chat id, kod indirme adresleri
// (paste/raw barındırma), PowerShell indirme sarmalları (Net.WebClient.DownloadString, IWR, Start-BitsTransfer ...),
// AMSI atlatma kalıpları ve kalıcılık izleri. Platform ve belge alanları (microsoft.com, github.com, example.com ...)
// "benign"a ayrılır. Tarayıcıda da çalışır (saf JS).
import { rx, snippet } from './text.js';

const BENIGN = ['github.com', 'microsoft.com', 'windows.com', 'windowsupdate.com', 'powershellgallery.com', 'learn.microsoft.com', 'w3.org',
  'example.com', 'example.org', 'example.net', 'mozilla.org', 'python.org', 'schemas.microsoft.com', 'go.microsoft.com'];
const isBenign = (host) => BENIGN.some((d) => host === d || host.endsWith(`.${d}`));
// kod/yük indirmek için kötüye kullanılan paste ve ham dosya barındırma servisleri
export const DOWNLOAD_HOSTS = /^(?:pastebin\.com|paste\.ee|hastebin\.com|rentry\.(?:co|org)|ghostbin\.\w+|raw\.githubusercontent\.com|gist\.githubusercontent\.com|cdn\.discordapp\.com|media\.discordapp\.net|transfer\.sh|files\.catbox\.moe|gofile\.io|bitbucket\.org|pastefy\.app|termbin\.com|ix\.io|0x0\.st|temp\.sh|anonfiles\.com|dropbox\.com|dl\.dropboxusercontent\.com|onedrive\.live\.com|drive\.google\.com|filebin\.net)$/i;
const githubDownload = (h, url) => /^github\.com$/i.test(h) && /\/(?:raw|releases\/download)\//i.test(url);
const FILE_TLD = /\.(?:ps1|psm1|psd1|exe|dll|bat|cmd|vbs|js|hta|txt|log|conf|cfg|ini|json|ya?ml|xml|zip|bin|tmp|bak|lnk|msi|scr|jpg|png)$/i;

const RE = {
  url: /\b(?:https?|ftp|wss?|stratum\+(?:tcp|ssl|tls)|tcp|udp|smb):\/\/[^\s'"<>()\\{}|^`[\];,]+/gi,
  email: /(?<![\w.+-])[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,24}\b/g,
  ip: /(?<![\d.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![\d.])/g,
  tgToken: /(?:(?<=bot)|(?<![\w:]))\d{8,10}:[A-Za-z0-9_-]{35}(?![\w-])/g,
  tgChat: /chat_?id['"\]]?\s*[:=]\s*['"]?(-?\d{5,16})/gi,
  discord: rx(['https://(?:ptb\\.|canary\\.)?discord(?:app)?\\.com/api/(?:v\\d+/)?', 'webhooks/\\d+/[\\w-]+'], 'g'),
  // New-Object Net.Sockets.TCPClient('host', 4444)
  tcp: rx(['net\\.sockets\\.tcp', 'client\\s*\\)?\\s*\\(?\\s*[\'"]([A-Za-z0-9.-]+)[\'"]\\s*,\\s*(\\d{1,5})'], 'gi'),
};

// indirme sarmalları, AMSI atlatma ve kalıcılık kesitleri
const CRADLES = [
  /(?:new-object\s+(?:system\.)?net\.webclient\s*\)?|\$\w+)\.download(?:string|file|data)\s*\([^)\n]{1,300}\)/gi,
  /(?:invoke-webrequest|\biwr\b|invoke-restmethod|\birm\b)\s+(?:-uri\s+)?['"]?https?:\/\/[^\s'")]{3,300}/gi,
  /start-bitstransfer\b[^\n;|]{0,200}/gi,
  /\bbitsadmin(?:\.exe)?\s+\/transfer\b[^\n;|]{0,200}/gi,
  /\bcertutil(?:\.exe)?\b[^\n;|]{0,40}-urlcache\b[^\n;|]{0,200}/gi,
  /\[(?:system\.)?net\.webrequest\]::create\s*\([^)\n]{0,300}\)/gi,
];
const AMSI = [rx(['\\[ref\\]\\.assembly\\.gettype\\([^)\\n]{0,120}amsi', 'utils[^\\n]{0,200}'], 'gi'), rx(['amsi', 'initfailed[^\\n]{0,120}'], 'gi'), rx(['amsi', 'scanbuffer[^\\n]{0,120}'], 'gi')];
const PERSIST = [
  /(?:hkcu|hklm|hkey_current_user|hkey_local_machine):?\\+software\\+microsoft\\+windows\\+currentversion\\+run(?:once)?\b[^\n;|]{0,120}/gi,
  /\bschtasks(?:\.exe)?\s+\/create\b[^\n;|]{0,200}/gi,
  /register-scheduledtask\b[^\n;|]{0,160}/gi,
  /\bnew-service\b[^\n;|]{0,160}/gi,
  /(?:__eventfilter|commandlineeventconsumer)[^\n;|]{0,120}/gi,
  /\\start menu\\programs\\startup\\[^\n'";|]{0,120}/gi,
];

const hostOf = (url) => {
  const m = url.match(/^[a-z][a-z+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/?#]+)/i);
  return m ? m[1].toLowerCase().replace(/\.$/, '') : null;
};
const isIp = (h) => /^\d+\.\d+\.\d+\.\d+$/.test(h);
// yerel/yayın adresleri ve sürüm numarası gibi görünenler (1.0.0.0) gürültüdür
const boringIp = (ip) => /^(?:0\.|127\.|255\.255\.255\.255$)/.test(ip);

/**
 * @param {string[]} texts taranacak metinler (girdi, katmanlar, çıktı)
 * @param {string[]} decoded çözülmüş metinler (çıktı ve katmanlar: sarmal ve kalıcılık kesitleri yalnızca bunlarda aranır)
 * @returns {{ urls, domains, ips, emails, discordWebhooks, telegram, downloads, cradles, amsi, persistence, benign: string[] }}
 */
export function iocs(texts, decoded = texts) {
  const sets = { urls: new Set(), domains: new Set(), ips: new Set(), emails: new Set(), discordWebhooks: new Set(), telegram: new Set(), downloads: new Set(),
    cradles: new Set(), amsi: new Set(), persistence: new Set(), benign: new Set() };
  const addHost = (h, loose = false) => {
    if (!h) return;
    h = h.toLowerCase().replace(/\.$/, '');
    if (isIp(h)) { if (!boringIp(h)) sets.ips.add(h); return; }
    if (!/^[a-z0-9.-]+\.[a-z]{2,24}$/i.test(h) || h === 'localhost' || (loose && FILE_TLD.test(h) && !DOWNLOAD_HOSTS.test(h))) return;
    (isBenign(h) ? sets.benign : sets.domains).add(h);
  };
  const addUrl = (u) => {
    const url = u.replace(/[.,;:!?'")\]$]+$/, '');
    const h = hostOf(url);
    if (!h) return;
    if (isBenign(h) && !githubDownload(h, url)) { sets.benign.add(h); return; }
    sets.urls.add(url);
    if (DOWNLOAD_HOSTS.test(h) || githubDownload(h, url)) sets.downloads.add(url);
    if (!githubDownload(h, url)) addHost(h);
  };
  for (const raw of texts) {
    if (!raw) continue;
    const text = raw.length > 8_000_000 ? raw.slice(0, 8_000_000) : raw;
    for (const [u] of text.matchAll(RE.url)) addUrl(u);
    for (const [u] of text.matchAll(RE.discord)) sets.discordWebhooks.add(u);
    for (const [e] of text.matchAll(RE.email)) {
      const host = e.split('@')[1].toLowerCase();
      if (FILE_TLD.test(host) || isBenign(host)) continue;
      sets.emails.add(e);
    }
    for (const [ip] of text.matchAll(RE.ip)) if (!boringIp(ip)) sets.ips.add(ip);
    for (const [tok] of text.matchAll(RE.tgToken)) sets.telegram.add(`bot:${tok}`);
    for (const m of text.matchAll(RE.tgChat)) sets.telegram.add(`chat_id:${m[1]}`);
    for (const m of text.matchAll(RE.tcp)) addHost(m[1], true);
  }
  for (const raw of decoded) {
    if (!raw) continue;
    const text = raw.length > 8_000_000 ? raw.slice(0, 8_000_000) : raw;
    for (const re of CRADLES) for (const [m] of text.matchAll(re)) if (sets.cradles.size < 50) sets.cradles.add(snippet(m, 160));
    for (const re of AMSI) for (const [m] of text.matchAll(re)) if (sets.amsi.size < 20) sets.amsi.add(snippet(m, 160));
    for (const re of PERSIST) for (const [m] of text.matchAll(re)) if (sets.persistence.size < 30) sets.persistence.add(snippet(m, 160));
  }
  return Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, [...v].sort()]));
}
