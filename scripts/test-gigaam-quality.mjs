/**
 * Три записи человеческой речи и авторские транскрипты из опубликованного
 * набора GeorgeFedoseev/DeepSpeech data/tiny-dataset/tiny-test. Файлы берутся
 * извне и фиксируются SHA-256 в Windows workflow; они не включены в проект.
 * Это маленькая проверка на одном домене, а не общий рейтинг качества.
 * GigaAM и ONNX реальные, Electron здесь подменён только для пути к модели.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadEngine, readWav, stubElectron } from './lib/engine-cli.mjs';
import { wordError } from './lib/word-error.mjs';

const dir = process.argv[2];
assert.ok(dir, 'Укажите каталог WAV и transcripts.csv');
stubElectron();
const giga = loadEngine('gigaam');
const require = createRequire(import.meta.url);
const prep = require('../electron/audioPrep.cjs');
const whisper = require('../electron/whisper.cjs');
assert.equal(giga.status().available, true, 'нет модели GigaAM');
const csv = fs.readFileSync(path.join(dir, 'transcripts.csv'), 'utf8');
const references = new Map(csv.split(/\r?\n/).slice(1).filter(Boolean).map((line) => {
  const fields = line.split(',');
  return [path.basename(fields[0]), fields.slice(2).join(',').trim()];
}));
const totals = { raw: { errors: 0, words: 0 }, prepared: { errors: 0, words: 0 } };
for (const name of ['ru_0052.wav', 'ru_0053.wav', 'ru_0054.wav']) {
  const ref = references.get(name);
  assert.ok(ref, `${name}: нет эталона`);
  const { pcm, sampleRate } = readWav(path.join(dir, name));
  assert.equal(sampleRate, 16000);
  const prepared = prep.preparePcm(pcm, { sampleRate }).pcm;
  const compacted = prep.compactSilence(prepared, { sampleRate }).pcm;
  const ready = whisper.trimSilence(compacted, sampleRate);
  console.log(`\n${name} (${(pcm.length / 32000).toFixed(1)} с) эталон: ${ref}`);
  for (const [mode, data] of [['raw', pcm], ['prepared', ready]]) {
    const res = await giga.transcribe(data, { sampleRate });
    assert.equal(res.ok, true, `${name}/${mode}: ${res.reason}`);
    const score = wordError(ref, res.text);
    totals[mode].errors += score.errors;
    totals[mode].words += score.referenceWords;
    console.log(`${mode}: ${res.text} | ${score.errors}/${score.referenceWords} слов ошибок, ${(100 * score.wer).toFixed(1)}%, ${res.ms} мс`);
  }
}
for (const mode of Object.keys(totals)) {
  const { errors, words } = totals[mode];
  console.log(`Итого ${mode}: ${errors}/${words}, WER ${(100 * errors / words).toFixed(1)}% (3 записи, один источник; не общая точность модели).`);
}
giga.unload();
