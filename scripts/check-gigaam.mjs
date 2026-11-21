/**
 * Проверка русской модели на настоящем звуке.
 *
 * Зачем отдельный скрипт: движок проверяется тестами на подставных сетях, а
 * качество распознавания можно проверить только настоящими весами и настоящей
 * речью. Здесь нет ни Electron, ни интерфейса — только модель и файл.
 *
 * Порядок:
 *   1) скачать модель (один раз, 226 МБ) — этим же путём, что и приложение;
 *   2) прогнать запись и посмотреть текст и время.
 *
 * Пример:
 *   node scripts/check-gigaam.mjs --download
 *   node scripts/check-gigaam.mjs записи/фраза.wav
 *   node scripts/check-gigaam.mjs --wav-dir записи
 */

import { collectWavs, downloadWithProgress, loadEngine, runFiles, stubElectron } from './lib/engine-cli.mjs';

stubElectron();
const gigaam = loadEngine('gigaam');
const args = process.argv.slice(2);

if (args.includes('--download')) {
  const state = await downloadWithProgress(gigaam);
  if (!state.available) process.exit(1);
  if (!args.some((arg) => arg.endsWith('.wav')) && !args.includes('--wav-dir')) process.exit(0);
}

const status = gigaam.status();
if (!status.available) {
  console.log(`Движок недоступен: ${status.reason}`);
  console.log('Скачать модель: node scripts/check-gigaam.mjs --download');
  process.exit(1);
}

const files = collectWavs(args);
if (!files.length) {
  console.log('Нечего распознавать: укажите файл .wav или папку через --wav-dir.');
  console.log(`Модель: ${status.available ? 'на месте' : status.reason}; папка: ${gigaam.modelDir()}`);
  process.exit(0);
}

await runFiles(gigaam, files);
