/**
 * Настоящие ONNX Runtime и веса приложения, без подмены сетей. WAV-файлы и
 * модели лежат вне репозитория. Пример:
 * ZS_USER_DATA=/tmp/zs-onnx node scripts/test-onnx-live.mjs gigaam /tmp/ru.wav --download
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadEngine, readWav, resample, stubElectron } from './lib/engine-cli.mjs';

const [name, wav, ...flags] = process.argv.slice(2);
if (!['gigaam', 'parakeet'].includes(name) || !wav) {
  console.error('Использование: node scripts/test-onnx-live.mjs gigaam|parakeet файл.wav [--download]');
  process.exit(2);
}
stubElectron();
const engine = loadEngine(name);

if (flags.includes('--download')) {
  let lastFile = '';
  const status = await engine.downloadModel({
    onProgress: ({ file, received, total }) => {
      if (file !== lastFile || received === total) {
        lastFile = file;
        console.log(`Загрузка ${file}: ${Math.round(received / 1048576)}/${Math.round(total / 1048576)} МБ`);
      }
    },
  });
  assert.equal(status.available, true, `модель недоступна: ${status.reason}`);
}

// status проверяет размеры, но не хеши уже существующих файлов. Для живого
// теста перепроверяем каждый файл: иначе частичный/подменённый кэш дал бы
// ложный результат. Файлы читаем потоком, не занимая сотни МБ памяти.
for (const file of engine.MODEL_FILES) {
  const fullPath = path.join(engine.modelDir(), file.name);
  const stat = fs.statSync(fullPath);
  assert.equal(stat.size, file.size, `${file.name}: неверный размер`);
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(fullPath)) hash.update(chunk);
  assert.equal(hash.digest('hex'), file.sha256, `${file.name}: неверный SHA-256`);
}
assert.equal(engine.status().available, true, engine.status().reason);
const source = readWav(wav);
const pcm = resample(source.pcm, source.sampleRate);
assert.ok(pcm.length > 32000, 'контрольный файл слишком короткий');
console.log(`${name}: ${(pcm.length / 32000).toFixed(2)} с, проверенные веса; начинаем распознавание`);

const first = await engine.transcribe(pcm, { sampleRate: 16000 });
assert.equal(first.ok, true, `распознавание не удалось: ${first.reason}`);
console.log(`Результат (${first.ms} мс): ${first.text}`);
// Ключевые слова, а не точное совпадение пунктуации и регистра: тест проверяет
// работоспособность реального пайплайна, а не качество модели на всём языке.
const text = first.text.toLocaleLowerCase();
const expected = name === 'gigaam' ? [/привет/u, /распознаван/u, /русск/u] : [/ask/i, /country/i];
for (const word of expected) assert.match(text, word, `не найдено ${word} в ответе модели`);
assert.ok(first.chunks >= 1, 'не указан обработанный фрагмент');

const second = await engine.transcribe(pcm, { sampleRate: 16000 });
assert.equal(second.ok, true, `повтор не удался: ${second.reason}`);
for (const word of expected) assert.match(second.text.toLocaleLowerCase(), word);
console.log(`Повтор с загруженной моделью: ${second.ms} мс.`);

// Проверяем нарезку и склейку настоящими весами. Повторяем известный образец,
// вставляя тишину между копиями: длина превышает двадцать секунд, и это не
// превращается в проверку произвольной речи или точности на длинных записях.
const silence = Buffer.alloc(16000 * 2 / 2);
const copies = Math.ceil((21 * 32000) / (pcm.length + silence.length));
const longPcm = Buffer.concat(Array.from({ length: copies }, () => [pcm, silence]).flat());
const longResult = await engine.transcribe(longPcm, { sampleRate: 16000 });
assert.equal(longResult.ok, true, `длинная запись: ${longResult.reason}`);
assert.ok(longResult.chunks > 1, `длинная запись не разбита: ${longResult.chunks}`);
const keyword = name === 'gigaam' ? /привет/giu : /country/gi;
assert.ok((longResult.text.match(keyword) || []).length >= 2, `потерялись повторённые фразы: ${longResult.text}`);
console.log(`Длинная запись: ${(longPcm.length / 32000).toFixed(1)} с, ${longResult.chunks} фрагментов; тест ${name} пройден.`);
engine.unload();
