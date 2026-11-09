/**
 * Проверка контракта IPC: каждый канал, который рендерер вызывает через
 * preload, должен иметь обработчик в main. Раньше отсутствующий обработчик
 * (store:get через invoke) приводил к тихому зависанию вызова.
 *
 * Запуск: node scripts/check-ipc.mjs
 */

import fs from 'node:fs';

const preload = fs.readFileSync('electron/preload.cjs', 'utf8');
const main = fs.readFileSync('electron/main.cjs', 'utf8');

/** Каналы вида invoke('name') — запрос-ответ. */
const invoked = [...new Set([...preload.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]))];
/** Каналы вида send('name') — события «выстрелил и забыл». */
const sent = [...new Set([...preload.matchAll(/send\('([^']+)'/g)].map((m) => m[1]))];

/** Обработчики главного процесса. */
const handled = new Set([
  ...[...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]),
  ...[...main.matchAll(/ipcMain\.on\('([^']+)'/g)].map((m) => m[1]),
]);

const missingInvoke = invoked.filter((c) => !handled.has(c));
const missingSend = sent.filter((c) => !handled.has(c));

let failed = false;
if (missingInvoke.length) {
  console.error(`✗ invoke без обработчика: ${missingInvoke.join(', ')}`);
  failed = true;
}
if (missingSend.length) {
  console.error(`✗ send без обработчика: ${missingSend.join(', ')}`);
  failed = true;
}

if (!failed) {
  console.log(`✓ IPC-контракт в порядке: ${invoked.length} invoke, ${sent.length} send, ${handled.size} обработчиков`);
}

process.exit(failed ? 1 : 0);
