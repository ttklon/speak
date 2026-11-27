/**
 * Сравнение настоящих Whisper base/small с разметкой трёх коротких записей.
 * Windows CLI из production-сборки, веса с закреплёнными SHA-256 в CI.
 * Electron заменён только для определения профиля; это НЕ полный GUI-путь,
 * НЕ server и НЕ оценка точности для всех голосов и микрофонов.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readWav, stubElectron } from './lib/engine-cli.mjs';
import { wordError } from './lib/word-error.mjs';
const dir = process.argv[2];
assert.ok(dir && process.env.ZS_USER_DATA, 'нужны каталог WAV и тестовый профиль');
stubElectron();
process.resourcesPath = path.resolve('release/win-unpacked/resources');
const require = createRequire(import.meta.url);
const prep = require('../electron/audioPrep.cjs');
const whisper = require('../electron/whisper.cjs');
const { writeWav } = require('../electron/wav.cjs');
assert.ok(whisper.findBinary(), 'whisper-cli из сборки отсутствует');
const references = new Map(fs.readFileSync(path.join(dir, 'transcripts.csv'), 'utf8')
  .split(/\r?\n/).slice(1).filter(Boolean).map((line) => {
    const fields = line.split(',');
    return [path.basename(fields[0]), fields.slice(2).join(',').trim()];
  }));
for (const model of ['base-q5_1', 'small-q5_1']) {
  assert.ok(whisper.findExactModel(model), `модель ${model} отсутствует`);
  let errors = 0, words = 0;
  for (const name of ['ru_0052.wav', 'ru_0053.wav', 'ru_0054.wav']) {
    const ref = references.get(name);
    assert.ok(ref, `${name}: нет эталона`);
    const { pcm, sampleRate } = readWav(path.join(dir, name));
    assert.equal(sampleRate, 16000);
    const prepared = prep.preparePcm(pcm, { sampleRate }).pcm;
    const ready = whisper.trimSilence(prep.compactSilence(prepared, { sampleRate }).pcm, sampleRate);
    const wav = path.join(dir, `prepared-${name}`);
    try {
      fs.writeFileSync(wav, writeWav(ready, sampleRate));
      const result = await whisper.transcribe(wav, { lang: 'ru', model, prompt: '', keepLoaded: false, useVad: true, thorough: false, timeout: 180000 });
      assert.equal(result.ok, true, `${model}/${name}: ${result.reason || result.code}`);
      const score = wordError(ref, result.text);
      errors += score.errors; words += score.referenceWords;
      console.log(`${model} ${name}: ${result.text} | ${score.errors}/${score.referenceWords} ошибок, ${(100 * score.wer).toFixed(1)}%, ${result.ms} мс, ${result.mode}`);
    } finally { fs.rmSync(wav, { force: true }); }
  }
  console.log(`Итого ${model}: ${errors}/${words}, WER ${(100 * errors / words).toFixed(1)}% (3 записи одного источника; это не общая точность).`);
}
