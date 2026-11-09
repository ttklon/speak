/**
 * Запуск ZSpeakly в Electron с горячей перезагрузкой Vite.
 * 1) поднимаем Vite dev-сервер (или используем уже запущенный);
 * 2) ждём порт 5173;
 * 3) стартуем Electron с ZSPEAKLY_DEV_URL.
 */

import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5173;

function waitForPort(port, timeoutMs = 60000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = createConnection({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) reject(new Error('Vite не поднялся'));
        else setTimeout(attempt, 400);
      });
    };
    attempt();
  });
}

async function main() {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

  let vite = null;
  try {
    await waitForPort(PORT, 1200);
    console.log('[dev] Vite уже запущен на', PORT);
  } catch {
    console.log('[dev] запускаю Vite…');
    vite = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--port', String(PORT)], {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
    });
    await waitForPort(PORT);
  }

  const electronBin = process.platform === 'win32'
    ? join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
    : join(root, 'node_modules', '.bin', 'electron');

  const child = spawn(electronBin, ['.'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ZSPEAKLY_DEV_URL: `http://localhost:${PORT}` },
  });

  child.on('exit', (code) => {
    vite?.kill();
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error('[dev] ошибка:', err.message);
  process.exit(1);
});
