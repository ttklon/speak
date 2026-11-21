/**
 * Проверка модели европейских языков на настоящем звуке.
 *
 * Зачем отдельный скрипт: движок проверяется тестами на подставных сетях, а
 * качество и скорость можно проверить только настоящими весами и настоящей
 * речью. Здесь нет ни Electron, ни интерфейса — только модель и файл.
 *
 * Порядок:
 *   1) скачать модель (один раз, ≈640 МБ) — этим же путём, что и приложение;
 *   2) прогнать запись по-английски (или на другом европейском языке) и
 *      посмотреть текст, время и скорость.
 *
 * Пример:
 *   node scripts/check-parakeet.mjs --download
 *   node scripts/check-parakeet.mjs записи/english.wav
 *   node scripts/check-parakeet.mjs --wav-dir записи
 */

import { collectWavs, downloadWithProgress, loadEngine, runFiles, stubElectron } from './lib/engine-cli.mjs';

stubElectron();
const parakeet = loadEngine('parakeet');
const args = process.argv.slice(2);

if (args.includes('--download')) {
  const state = await downloadWithProgress(parakeet);
  if (!state.available) process.exit(1);
  if (!args.some((arg) => arg.endsWith('.wav')) && !args.includes('--wav-dir')) process.exit(0);
}

const status = parakeet.status();
if (!status.available) {
  console.log(`Движок недоступен: ${status.reason}`);
  console.log('Скачать модель: node scripts/check-parakeet.mjs --download');
  process.exit(1);
}

const files = collectWavs(args);
if (!files.length) {
  console.log('Нечего распознавать: укажите файл .wav или папку через --wav-dir.');
  console.log(`Модель: ${status.available ? 'на месте' : status.reason}; папка: ${parakeet.modelDir()}`);
  process.exit(0);
}

await runFiles(parakeet, files);
