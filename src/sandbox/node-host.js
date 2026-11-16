// Node (CLI ve testler) için bekçili çözücü: hat ayrı, yalıtılmış bir alt süreçte çalışır (node --permission; yalnızca
// src ve node_modules okunabilir, yazma, ağ, alt süreç ve worker kapalı). Kilitlenen süreç bekçi tarafından öldürülüp
// yeniden başlatılır.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { sandboxApi } from './api.js';
import { createWatchdog } from './watchdog.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
// izin modeli gerçek yola bakar (junction/symlink)
const modules = realpathSync(path.join(root, 'node_modules'));
const src = path.join(root, 'src');
const PROC = path.join(here, 'node-proc.js');

/** Alt sürecin Node bayrakları: izin modeli (yalnızca okuma, yalnızca src ve node_modules) ve bellek sınırı */
export const SANDBOX_ARGS = ['--max-old-space-size=1024', '--permission', `--allow-fs-read=${modules}${path.sep}*`, `--allow-fs-read=${src}${path.sep}*`, `--allow-fs-read=${path.join(root, 'package.json')}`];

export function createNodeSandbox() {
  const dog = createWatchdog({
    spawn() {
      const child = fork(PROC, [], {
        execArgv: SANDBOX_ARGS,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        serialization: 'advanced',
      });
      let onErr = () => {};
      let stderr = '';
      child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
      child.on('error', (e) => onErr(e?.message ?? String(e)));
      child.on('exit', (code) => { if (code !== 0 && code !== null) onErr(`çözücü süreci çıktı (${code}): ${stderr.trim().split('\n').pop() ?? ''}`); });
      return {
        post: (m) => child.send(m),
        onMessage: (cb) => child.on('message', (m) => { if (!m?.ready) cb(m); }),
        onError: (cb) => { onErr = cb; },
        terminate: () => { onErr = () => {}; child.kill(); },
        ref: () => { child.ref(); child.channel?.ref(); },
        unref: () => { child.unref(); child.channel?.unref(); },
      };
    },
  });
  return { ...sandboxApi(dog.send), watchdogStats: dog.stats, kill: (reason) => dog.kill(reason), close: () => dog.terminate() };
}
