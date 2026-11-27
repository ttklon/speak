#!/usr/bin/env node
/**
 * Проверка помощника ввода на настоящей Windows.
 *
 * Зачем отдельный шаг в сборке. Помощник — это C#, который компилируется
 * `csc.exe` уже на машине человека. В Linux-песочнице и в юнит-тестах проверить
 * компиляцию невозможно: их максимум — убедиться, что исходник не содержит
 * синтаксиса новее C# 5 и что скобки сбалансированы. Настоящую проверку делает
 * Windows-раннер: он собирает помощник тем же путём, что и приложение, и
 * запускает его. Если не соберётся — сборка падает здесь, а не у человека,
 * который нажимает «диктовка» и не получает текста.
 *
 * Запускается из job'а на windows-latest: `node scripts/check-wininput.cjs`.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWinInput, findCompiler } = require('../electron/winInput.cjs');

const log = (message) => console.log(`• ${message}`);
const fail = (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

async function main() {
  if (process.platform !== 'win32') {
    log('не Windows — шаг пропущен (проверка живёт в Windows-сборке)');
    return;
  }

  const compiler = findCompiler();
  if (!compiler) fail('не нашёлся csc.exe из .NET Framework — помощник не собрать');
  log(`компилятор: ${compiler}`);

  const dir = path.join(os.tmpdir(), `zs-input-check-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  const input = createWinInput({ baseDir: dir });

  const state = await input.ensure();
  if (!state.ready) fail(`помощник не собрался: ${state.reason}`);
  if (!fs.existsSync(state.path)) fail(`нет файла помощника: ${state.path}`);
  const size = fs.statSync(state.path).size;
  if (size < 2048) fail(`файл помощника подозрительно мал: ${size} Б`);
  log(`помощник собран: ${state.path} (${size} Б)`);

  // 1. Ответ на PING: процесс запускается и печатает JSON с заголовком окна.
  const ping = await input.ping();
  if (!ping.ok) fail(`помощник не отвечает: ${JSON.stringify(ping)}`);
  log(`ответ на ping: ${JSON.stringify(ping).slice(0, 120)}`);

  // Не посылаем клавиши в неизвестное активное окно: отдельная проверка
  // test-wininput-window.cjs создаёт цель и проверяет её фокус перед вводом.
  // Возврат SendInput сам по себе не доказывает, что поле получило текст.

  fs.rmSync(dir, { recursive: true, force: true });
  log('помощник ввода проверен на этой Windows');
}

main().catch((error) => {
  console.error(`✗ проверка помощника упала: ${error?.stack || error}`);
  process.exit(1);
});
