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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Подменяем Electron: движку нужен только путь к профилю приложения.
const userData = process.env.ZS_USER_DATA || path.join(os.homedir(), '.zspeakly-check');
fs.mkdirSync(userData, { recursive: true });
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => userData, getAppPath: () => process.cwd(), getVersion: () => 'check' } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const gigaam = require(path.resolve('electron/gigaam.cjs'));

/** Минимальный разбор WAV: 16-битный моно/стерео PCM. */
function readWav(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${file}: это не WAV`);
  }
  let offset = 12;
  let channels = 1;
  let sampleRate = 16000;
  let bits = 16;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bits = buffer.readUInt16LE(body + 14);
    } else if (id === 'data') {
      data = buffer.subarray(body, body + size);
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!data) throw new Error(`${file}: нет звука`);
  if (bits !== 16) throw new Error(`${file}: нужен 16-битный звук, а тут ${bits} бит`);
  if (channels === 1) return { pcm: Buffer.from(data), sampleRate, channels };
  // стерео → моно: среднее двух каналов
  const frames = Math.floor(data.length / (2 * channels));
  const mono = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch++) sum += data.readInt16LE((i * channels + ch) * 2);
    mono.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / channels))), i * 2);
  }
  return { pcm: mono, sampleRate, channels: 1 };
}

/** Пересчёт частоты: движку нужен ровно 16 кГц, иначе он честно откажется. */
function resample(pcm, from, to = 16000) {
  if (from === to) return pcm;
  const input = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  const ratio = from / to;
  const outLength = Math.floor(input.length / ratio);
  const out = Buffer.alloc(outLength * 2);
  for (let i = 0; i < outLength; i++) {
    const at = i * ratio;
    const left = Math.floor(at);
    const right = Math.min(input.length - 1, left + 1);
    const value = input[left] + (input[right] - input[left]) * (at - left);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), i * 2);
  }
  return out;
}

const args = process.argv.slice(2);
if (args.includes('--download')) {
  console.log(`Скачиваю модель в ${gigaam.modelDir()} …`);
  let last = -1;
  const state = await gigaam.downloadModel({
    onProgress: ({ received, total }) => {
      const percent = total ? Math.round((received / total) * 100) : 0;
      if (percent !== last) {
        last = percent;
        process.stdout.write(`\r  ${percent}% (${Math.round(received / 1048576)} из ${Math.round(total / 1048576)} МБ)`);
      }
    },
  });
  process.stdout.write('\n');
  console.log(state.available ? 'Готово: модель на месте.' : `Не получилось: ${state.reason}`);
  if (!state.available) process.exit(1);
  if (!args.some((arg) => arg.endsWith('.wav')) && !args.includes('--wav-dir')) process.exit(0);
}

const status = gigaam.status();
if (!status.available) {
  console.log(`Движок недоступен: ${status.reason}`);
  console.log('Скачать модель: node scripts/check-gigaam.mjs --download');
  process.exit(1);
}

const files = [];
const dirIndex = args.indexOf('--wav-dir');
if (dirIndex >= 0 && args[dirIndex + 1]) {
  const dir = args[dirIndex + 1];
  for (const name of fs.readdirSync(dir).sort()) {
    if (/\.wav$/i.test(name)) files.push(path.join(dir, name));
  }
} else {
  files.push(...args.filter((arg) => /\.wav$/i.test(arg)));
}
if (!files.length) {
  console.log('Нечего распознавать: укажите файл .wav или папку через --wav-dir.');
  console.log(`Модель: ${status.available ? 'на месте' : status.reason}; папка: ${gigaam.modelDir()}`);
  process.exit(0);
}

let totalMs = 0;
let totalSeconds = 0;
for (const file of files) {
  const { pcm, sampleRate } = readWav(file);
  const audio = resample(pcm, sampleRate);
  const seconds = audio.length / 2 / 16000;
  const result = await gigaam.transcribe(audio, { sampleRate: 16000 });
  totalMs += result.ms;
  totalSeconds += seconds;
  const speed = result.ms > 0 ? (seconds / (result.ms / 1000)).toFixed(1) : '—';
  console.log(`\n${path.basename(file)} — ${seconds.toFixed(1)} с речи`);
  console.log(`  ${result.ok ? result.text : `ошибка: ${result.reason}`}`);
  console.log(`  ${(result.ms / 1000).toFixed(2)} с счёта (${speed}× быстрее реального времени), кусков: ${result.chunks}`);
}
if (files.length > 1) {
  const speed = totalMs > 0 ? (totalSeconds / (totalMs / 1000)).toFixed(1) : '—';
  console.log(`\nИтого: ${totalSeconds.toFixed(1)} с речи за ${(totalMs / 1000).toFixed(2)} с (${speed}×).`);
}
