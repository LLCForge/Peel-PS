// Web Worker tarafı: çözme hattı (engine.js). Betik hiçbir zaman çalıştırılmaz; bu worker yalnızca güvenilmez metni
// ayrıştırır ve statik olarak değerlendirir. Yine de, değerlendiricide beklenmeyen bir açık kalsa bile dış dünyaya
// erişilemesin diye yalıtım worker düzeyindedir:
//  1. CSP: worker betiğinin yanıt başlığı (dev/preview: vite.config.js ara katmanı, üretim: public/_headers)
//     default-src 'none'; script-src 'self'; connect-src 'self'
//  2. JS kilidi: ağ API'leri, eval/Function kurucuları, dizge zamanlayıcıları, iç içe worker ve kalıcı depolama
//     kaldırılır. Başlık veremeyen barındırmada tek katman budur; durum ana thread'e ilk işten önce 'env' iletisiyle bildirilir.
import { runPeel } from './engine.js';

// CSP sınaması: bu betiğin kendi yanıtı yeniden (aynı köken) okunur ve başlıkta connect-src 'self' aranır.
// HEAD yerine tek baytlık aralık isteği: vite preview HEAD yanıtını yarıda keser (konsolda ERR_ABORTED)
const cspProbe = fetch(self.location.href, { cache: 'no-store', headers: { Range: 'bytes=0-0' } })
  .then(async (r) => {
    await r.arrayBuffer();
    return /(^|;)\s*connect-src 'self'\s*(;|$)/.test(r.headers.get('content-security-policy') ?? '');
  }, () => false);

// Kaldırılan genel adlar: ağ, kod üretme, iç içe worker, kalıcı depolama
const BLOCKED = [
  'fetch', 'fetchLater', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport',
  'importScripts', 'Worker', 'SharedWorker', 'caches', 'BroadcastChannel', 'indexedDB',
];
const denied = () => { throw new EvalError('Peel sandbox: kod üretimi kapalı'); };

function lockdown() {
  const ctorProtos = [
    Function.prototype,
    Object.getPrototypeOf(async function () {}),
    Object.getPrototypeOf(function* () {}),
    Object.getPrototypeOf(async function* () {}),
  ];
  for (const name of BLOCKED) {
    for (let o = self; o; o = Object.getPrototypeOf(o)) {
      if (Object.prototype.hasOwnProperty.call(o, name)) {
        Object.defineProperty(o, name, { value: undefined, writable: false, configurable: false });
      }
    }
  }
  // Function silinmez ('x instanceof Function' çalışsın): aynı prototipi taşıyan, çağrılınca hata veren sahte.
  // Kuruculara prototip üzerinden de ulaşılmasın: (async () => {}).constructor('...')
  const BlockedFunction = function Function() { denied(); };
  BlockedFunction.prototype = Function.prototype;
  const freeze = (o, k, value) => Object.defineProperty(o, k, { value, writable: false, configurable: false });
  freeze(self, 'eval', denied);
  freeze(self, 'Function', BlockedFunction);
  for (const proto of ctorProtos) freeze(proto, 'constructor', BlockedFunction);
  for (const name of ['setTimeout', 'setInterval']) {
    const real = self[name];
    Object.defineProperty(self, name, {
      value: (fn, ...rest) => (typeof fn === 'function' ? real(fn, ...rest) : 0),
      writable: false,
      configurable: false,
    });
  }
}

const ready = (async () => {
  const csp = await cspProbe;
  lockdown();
  self.postMessage({ type: 'env', csp, locked: true });
})();

self.addEventListener('message', async ({ data }) => {
  const { id, ...msg } = data ?? {};
  let result;
  try {
    await ready;
    if (msg.type !== 'peel') throw new Error(`bilinmeyen ileti: ${msg.type}`);
    result = await runPeel(msg);
  } catch (err) {
    result = { ok: false, error: String(err?.message ?? err).split('\n').filter(Boolean).slice(-3).join(' | '), logs: [], passes: [], snapshots: [] };
  }
  self.postMessage({ id, ...result });
});
