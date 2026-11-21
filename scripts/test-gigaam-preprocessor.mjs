/** Настоящий ONNX-граф подготовки GigaAM на 16-кГц WAV; веса ASR не нужны. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readWav, resample } from './lib/engine-cli.mjs';

const require = createRequire(import.meta.url);
const ort = require('onnxruntime-node');
const wav = process.argv[2];
if (!wav) throw new Error('Укажите файл WAV');
const input = readWav(wav);
const pcm = resample(input.pcm, input.sampleRate);
const samples = new Float32Array(pcm.length / 2);
for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
assert.ok(samples.length >= 16000, 'запись короче одной секунды');
const session = await ort.InferenceSession.create('electron/assets/gigaam/v3-preprocessor.onnx', {
  executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1,
});
const output = await session.run({
  waveforms: new ort.Tensor('float32', samples, [1, samples.length]),
  waveforms_lens: new ort.Tensor('int64', BigInt64Array.from([BigInt(samples.length)]), [1]),
});
assert.equal(output.features.type, 'float32');
assert.deepEqual(output.features.dims.slice(0, 2), [1, 64]);
const frames = Number(output.features_lens.data[0]);
assert.equal(frames, output.features.dims[2]);
assert.ok(frames > 0);
let min = Infinity, max = -Infinity;
for (const value of output.features.data) {
  assert.ok(Number.isFinite(value), 'признаки содержат NaN или бесконечность');
  min = Math.min(min, value);
  max = Math.max(max, value);
}
assert.ok(max > min, 'признаки не меняются');
console.log(`Граф GigaAM: ${samples.length} сэмплов → 64 × ${frames} конечных признаков.`);
await session.release();
