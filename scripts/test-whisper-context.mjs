/** Isolate Whisper CLI audio context and VAD on the same labelled recordings.
 * All combinations use identical beam/fallback settings, same prepared WAV.
 * This is a small diagnostic, not a general accuracy benchmark. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readWav, stubElectron } from './lib/engine-cli.mjs';
import { wordError } from './lib/word-error.mjs';
const dir = process.argv[2];
assert.ok(dir && process.env.ZS_USER_DATA);
stubElectron();
process.resourcesPath = path.resolve('release/win-unpacked/resources');
const require = createRequire(import.meta.url);
const prep = require('../electron/audioPrep.cjs');
const whisper = require('../electron/whisper.cjs');
const { writeWav } = require('../electron/wav.cjs');
const bin = whisper.findBinary();
const model = whisper.findExactModel('small-q5_1');
assert.ok(bin && model, 'отсутствует CLI или small-q5_1');
const vad = whisper.findVadModel();
assert.ok(vad, 'VAD отсутствует: сравнение параметров невозможно');
const refs = new Map(fs.readFileSync(path.join(dir, 'transcripts.csv'), 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map((line) => {
  const fields = line.split(','); return [path.basename(fields[0]), fields.slice(2).join(',').trim()];
}));
const totals = new Map();
for (const name of ['ru_0052.wav', 'ru_0053.wav', 'ru_0054.wav']) {
  const ref = refs.get(name);
  assert.ok(ref);
  const { pcm, sampleRate } = readWav(path.join(dir, name));
  assert.equal(sampleRate, 16000);
  const prepared = prep.preparePcm(pcm, { sampleRate }).pcm;
  const ready = whisper.trimSilence(prep.compactSilence(prepared, { sampleRate }).pcm, sampleRate);
  const wav = path.join(dir, `context-${name}`);
  fs.writeFileSync(wav, writeWav(ready, sampleRate));
  try {
    for (const [label, ctx, vadModel] of [
      ['short-vad', whisper.computeAudioCtx(wav), vad],
      ['full-vad', 0, vad],
      ['short-no-vad', whisper.computeAudioCtx(wav), ''],
      ['full-no-vad', 0, ''],
    ]) {
      const outBase = path.join(dir, `result-${label}`);
      const args = whisper.cliArgs({ modelPath: model, wavPath: wav, lang: 'ru', threads: 4, vadModel,
        outBase, beamSize: 3, audioCtx: ctx, fallback: false });
      const result = spawnSync(bin, args, { timeout: 180000, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
      try {
        assert.equal(result.status, 0, `${name}/${label}: ${result.error || result.stderr}`);
        const text = fs.readFileSync(`${outBase}.txt`, 'utf8').trim();
        const score = wordError(ref, text);
        const prev = totals.get(label) || { errors: 0, words: 0 };
        prev.errors += score.errors; prev.words += score.referenceWords; totals.set(label, prev);
        console.log(`${name} ${label} ctx=${ctx}: ${text} | ${score.errors}/${score.referenceWords}`);
      } finally { fs.rmSync(`${outBase}.txt`, { force: true }); }
    }
  } finally { fs.rmSync(wav, { force: true }); }
}
for (const [label, score] of totals) console.log(`Итого ${label}: ${score.errors}/${score.words}, WER ${(100 * score.errors / score.words).toFixed(1)}% (только эти три записи).`);
