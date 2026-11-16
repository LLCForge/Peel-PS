// Çözücü bekçisi. Hattın kendi süre/adım bütçesi değerlendirici adımları arasında denetlenir; felaket bir düzenli ifade
// ya da beklenmeyen bir kilitlenme bulunduğu thread'i yine de kilitleyebilir. Çözücü ayrı bir worker'da (tarayıcı) ya da
// alt süreçte (Node) çalışır; istekler sırayla gönderilir ve her birinin bir son tarihi vardır. Süre aşılırsa worker
// sonlandırılır, yenisi istek gelince başlatılır; çağırana zaman aşımı hatası döner.

// Her ileti kendi son tarihini taşır (deadlineMs)
export const deadlineOf = (msg) => Number(msg.deadlineMs) || 45000;

const failure = (error, extra = {}) => ({ ok: false, error, logs: [], passes: [], snapshots: [], ...extra });

/**
 * @param {object} o
 * @param {() => { post(msg): void, onMessage(cb): void, onError(cb): void, terminate(): void, ref?(): void, unref?(): void }} o.spawn
 * @param {(msg) => object} [o.prepare] istek gönderilmeden önce dönüştürülür (ör. arayüz ayarları)
 * @param {(msg) => number} [o.deadline]
 */
export function createWatchdog({ spawn, prepare = (m) => m, deadline = deadlineOf, onRestart = () => {} }) {
  let engine = null;
  let seq = 0;
  let current = null; // { id, resolve, timer, msg }
  const queue = [];
  const stats = { restarts: 0, timeouts: 0 };

  function start() {
    engine = spawn();
    engine.onMessage((data) => {
      if (!current || data.id !== current.id) return;
      const { resolve, timer } = current;
      clearTimeout(timer);
      current = null;
      const { id, ...rest } = data;
      resolve(rest);
      pump();
    });
    engine.onError((message) => restart(message || 'Sandbox worker hatası'));
    return engine;
  }

  // motor öldürülür; uçuştaki istek hata alır, kuyruktakiler yeni motorda devam eder
  function restart(error, extra = {}) {
    engine?.terminate();
    engine = null;
    stats.restarts++;
    onRestart(error);
    if (current) {
      clearTimeout(current.timer);
      current.resolve(failure(error, extra));
      current = null;
    }
    pump();
  }

  function pump() {
    if (current || !queue.length) {
      if (!current && !queue.length) engine?.unref?.();
      return;
    }
    const job = queue.shift();
    current = job;
    const e = engine ?? start();
    e.ref?.();
    const ms = deadline(job.msg);
    job.timer = setTimeout(() => {
      stats.timeouts++;
      restart(`zaman aşımı: motor ${ms} ms içinde yanıt vermedi, yeniden başlatıldı (bekçi)`, { timedOut: true, watchdog: true });
    }, ms);
    e.post({ id: job.id, ...job.msg });
  }

  function send(msg) {
    return new Promise((resolve) => {
      queue.push({ id: ++seq, msg: prepare(msg), resolve });
      pump();
    });
  }

  // tüm işleri keser (arayüzde Durdur); bağlamlar kaybolur
  function kill(error = 'Durduruldu') {
    for (const j of queue.splice(0)) j.resolve(failure(error));
    if (current) { clearTimeout(current.timer); current.resolve(failure(error)); current = null; }
    engine?.terminate();
    engine = null;
  }

  return { send, kill, stats, terminate: () => kill('Kapatıldı') };
}
