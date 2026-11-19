/**
 * Русский движок: GigaAM v3 (Сбер, MIT) в формате ONNX на процессоре.
 *
 * Зачем он нужен, если уже есть whisper. Whisper обучен в основном на английском
 * и на русском путает падежи, имена и термины, а пунктуацию угадывает. GigaAM
 * обучен на русской речи и выдаёт текст сразу со знаками препинания и
 * заглавными буквами — то есть убирает второй этап чистки и главную причину
 * жалобы «быстро, но нечитаемо».
 *
 * Как устроено (порядок шагов сверен с тремя независимыми реализациями:
 * onnx-asr, TypeWhisper.Plugin.GigaAm и giga-pisar-cli):
 *
 *   звук 16 кГц → маленький граф признаков (44 КБ, лежит рядом) → энкодер
 *   (int8, 224 МБ) → жадное декодирование RNN-T: декодер + джойнт по кадрам →
 *   словарь → текст
 *
 * Что важно знать про поведение:
 *  • веса не входят в установщик и скачиваются один раз (226 МБ) с проверкой
 *    размера и SHA-256 — недокачанный файл не станет «моделью»;
 *  • запись длиннее 20 секунд режется в самом тихом месте около середины;
 *  • модель знает только русский: текст на другом языке она прочитает по-русски,
 *    поэтому включается она только для русского языка;
 *  • если ONNX Runtime или файлы недоступны, движок честно говорит об этом и
 *    диктовка остаётся на whisper — молчаливой подмены нет.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const { downloadFiles, hashFile, safeUnlink } = require('./modelDownload.cjs');

const { SAMPLE_RATE, append, chunkRanges, continuing, DEFAULT_MAX_SECONDS } = require('./chunking.cjs');
const { parseVocabulary, tokensToText } = require('./gigaamVocab.cjs');

/** Коммит репозитория модели: адрес обязан указывать на байты, а не на «main». */
const REVISION = '322c3b29492673eb7d0b434bfa9dfb8653e34d02';
const BASE_URL = `https://huggingface.co/istupakov/gigaam-v3-onnx/resolve/${REVISION}`;

/**
 * Файлы модели: имя, точный размер и SHA-256 на закреплённом коммите.
 * Размер и хеш — не «на глаз»: это идентификаторы объектов LFS из дерева
 * репозитория, поэтому подменённый или недокачанный файл отсекается сразу.
 */
const MODEL_FILES = [
  {
    name: 'v3_e2e_rnnt_encoder.int8.onnx',
    size: 224570477,
    sha256: '4e0e076a6076cd110277e529b8ac8f32cd5297f7fbebad5341ae8ddb7d00817b',
  },
  {
    name: 'v3_e2e_rnnt_decoder.int8.onnx',
    size: 1159170,
    sha256: '89014e134865615b91e037157e46e389b1271e6072460efc010ea08e61e23146',
  },
  {
    name: 'v3_e2e_rnnt_joint.int8.onnx',
    size: 687791,
    sha256: 'ade116563dbf66e503b0994efab6b5861412743e52bf31c39fc3fffa3783d5d1',
  },
  {
    name: 'v3_e2e_rnnt_vocab.txt',
    size: 13354,
    sha256: '39abae20e692998290c574e606f11a9edef2902a1995463fcff63d1490cf22b7',
  },
];

/** Граф признаков поставляется с приложением: он крошечный и обязан совпадать с эталоном. */
const PREPROCESSOR_NAME = 'v3-preprocessor.onnx';
const PREDICTION_HIDDEN = 320;
const MAX_TOKENS_PER_STEP = 3;

/** Сколько всего занимает модель — показывается человеку до скачивания. */
const MODEL_BYTES = MODEL_FILES.reduce((sum, file) => sum + file.size, 0);

/** Файлы модели: в тестах подменяются мелкими, чтобы проверять скачивание и хеши. */
function modelFiles() {
  return injected?.files || MODEL_FILES;
}

let ortCache; // { module } | { error }
let sessionCache; // { preprocessor, encoder, decoder, joint, vocab, dims }
let downloadState = null; // { cancelled, received, total }
let transcribeCancelled = false;
let transcribeActive = false;
let injected = null; // подставные сети для тестов

function modelDir() {
  return path.join(app.getPath('userData'), 'models', 'gigaam');
}

/** Где лежит граф признаков: сначала рядом с установленным приложением, потом в исходниках. */
function preprocessorPath() {
  const roots = [
    process.resourcesPath && path.join(process.resourcesPath, 'gigaam'),
    path.join(__dirname, 'assets', 'gigaam'),
    path.join(app.getAppPath(), 'electron', 'assets', 'gigaam'),
  ].filter(Boolean);
  for (const dir of roots) {
    const file = path.join(dir, PREPROCESSOR_NAME);
    try {
      if (fs.existsSync(file)) return file;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Каких файлов модели не хватает (по имени). */
function missingFiles() {
  const dir = modelDir();
  return modelFiles().filter((file) => {
    try {
      const stat = fs.statSync(path.join(dir, file.name));
      return stat.size !== file.size;
    } catch {
      return true;
    }
  }).map((file) => file.name);
}

/**
 * Состояние движка для интерфейса и диагностики.
 * @returns {{ available: boolean, ready: boolean, reason: string, missing: string[], bytes: number, dir: string }}
 */
function status() {
  // В тестах сети подставные: файлов и рантайма может не быть вовсе, но движок
  // с ними работает — состояние должно говорить правду.
  if (injected?.sessions) {
    return { available: true, ready: true, reason: '', missing: [], bytes: 0, dir: modelDir() };
  }
  const missing = missingFiles();
  const bytes = modelFiles().reduce((sum, file) => sum + file.size, 0);
  const pre = preprocessorPath();
  if (!pre) {
    return {
      available: false,
      ready: false,
      reason: 'нет графа признаков — приложение собрано не полностью',
      missing,
      bytes,
      dir: modelDir(),
    };
  }
  if (missing.length) {
    return {
      available: false,
      ready: false,
      reason: missing.length === modelFiles().length ? 'модель не скачана' : 'модель скачана не полностью',
      missing,
      bytes,
      dir: modelDir(),
    };
  }
  // Файлы на месте — проверяем, чем считать. Без модуля расчёта движок
  // недоступен, и человек должен увидеть причину, а не «ничего не произошло».
  const ort = loadOrt();
  if (!ort.module) {
    return { available: false, ready: false, reason: ort.error, missing, bytes, dir: modelDir() };
  }
  return { available: true, ready: true, reason: '', missing: [], bytes, dir: modelDir() };
}

/** ленивая загрузка ONNX Runtime: без него движок просто недоступен, приложение работает */
function loadOrt() {
  if (injected?.ort) return { module: injected.ort };
  if (ortCache) return ortCache;
  try {
    // eslint-disable-next-line global-require
    const module = require('onnxruntime-node');
    ortCache = { module };
  } catch (err) {
    ortCache = {
      error: `нет модуля расчёта моделей (${String(err?.message || err).slice(0, 120)})`,
    };
  }
  return ortCache;
}

/** Параметры сессий: половина ядер, как в референсной реализации — остальное нужно системе. */
function sessionOptions() {
  const cpus = require('node:os').cpus()?.length || 4;
  return {
    executionProviders: ['cpu'],
    intraOpNumThreads: Math.max(1, Math.floor(cpus / 2)),
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
    executionMode: 'sequential',
    logSeverityLevel: 3,
  };
}

/** Обёртка над сессией ONNX Runtime: в тестах на её месте подставная сеть с тем же видом. */
async function wrapSession(ort, file) {
  const session = await ort.InferenceSession.create(file, sessionOptions());
  return {
    inputNames: session.inputNames,
    outputNames: session.outputNames,
    async run(feeds) {
      const tensors = {};
      for (const [name, value] of Object.entries(feeds)) {
        tensors[name] = new ort.Tensor(value.type, value.data, value.dims);
      }
      const result = await session.run(tensors);
      const out = {};
      for (const [name, tensor] of Object.entries(result)) {
        out[name] = {
          data: tensor.data,
          dims: tensor.dims,
          get(index) {
            return tensor.data[Number(index)];
          },
        };
      }
      return out;
    },
  };
}

/** Открыть сети (один раз за запуск приложения). */
async function openSessions() {
  if (injected?.sessions) return injected.sessions;
  if (sessionCache) return sessionCache;
  const ort = loadOrt();
  if (!ort.module) throw new Error(ort.error || 'нет модуля расчёта моделей');
  const dir = modelDir();
  const named = (suffix) => (modelFiles().find((file) => file.name.endsWith(suffix)) || {}).name;
  const vocabText = fs.readFileSync(path.join(dir, named('vocab.txt')), 'utf8');
  const vocab = parseVocabulary(vocabText);
  const pre = preprocessorPath();
  if (!pre) throw new Error('нет графа признаков');
  sessionCache = {
    preprocessor: await wrapSession(ort.module, pre),
    encoder: await wrapSession(ort.module, path.join(dir, named('encoder.int8.onnx'))),
    decoder: await wrapSession(ort.module, path.join(dir, named('decoder.int8.onnx'))),
    joint: await wrapSession(ort.module, path.join(dir, named('joint.int8.onnx'))),
    vocab,
  };
  return sessionCache;
}

/** Выгрузить сети: память энкодера (224 МБ весов) нужна не всегда. */
function unload() {
  sessionCache = null;
}

/** int16 PCM (буфер Electron) → Float32Array −1…1. */
function toSamples(pcm) {
  const view = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm || []);
  const usable = view.byteLength - (view.byteLength % 2);
  const out = new Float32Array(usable / 2);
  const data = Buffer.from(view.buffer, view.byteOffset, usable);
  for (let i = 0; i < out.length; i++) out[i] = data.readInt16LE(i * 2) / 32768;
  return out;
}

function argmax(values) {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
  return best;
}

/**
 * Один кусок: признаки → энкодер → жадный RNN-T.
 * @param {{preprocessor: object, encoder: object, decoder: object, joint: object, vocab: object}} s
 * @param {Float32Array} samples 16 кГц, короче предела
 */
async function transcribeChunk(s, samples, onFrame) {
  const input = samples.length >= SAMPLE_RATE ? samples : paddedToSecond(samples);

  const features = await s.preprocessor.run({
    waveforms: { type: 'float32', data: input, dims: [1, input.length] },
    waveforms_lens: { type: 'int64', data: BigInt64Array.from([BigInt(input.length)]), dims: [1] },
  });
  const featureTensor = features.features;
  const featureFrames = Number(features.features_lens.get(0));

  const encoded = await s.encoder.run({
    audio_signal: { type: 'float32', data: featureTensor.data, dims: featureTensor.dims },
    length: { type: 'int64', data: BigInt64Array.from([BigInt(featureFrames)]), dims: [1] },
  });
  const encodedTensor = encoded.encoded;
  if (encodedTensor.dims.length !== 3 || encodedTensor.dims[0] !== 1) {
    throw new Error(`модель вернула неожиданную форму [${encodedTensor.dims.join(', ')}]`);
  }
  const dim = encodedTensor.dims[1];
  const totalFrames = encodedTensor.dims[2];
  const frames = Math.min(Math.max(Number(encoded.encoded_len.get(0)), 0), totalFrames);

  // Энкодер выдаёт [1, признак, кадр] — джойнту нужен один кадр целиком.
  const flat = encodedTensor.data;
  const frameVector = new Float32Array(dim);
  const blank = s.vocab.blankId;
  let hidden = new Float32Array(PREDICTION_HIDDEN);
  let cell = new Float32Array(PREDICTION_HIDDEN);
  let lastToken = blank;
  let prediction = null;
  const tokens = [];
  let emitted = 0;

  for (let frame = 0; frame < frames; ) {
    if (transcribeCancelled) throw new Error('отменено');
    if (!prediction) prediction = await runDecoder(s, lastToken, hidden, cell);
    for (let i = 0; i < dim; i++) frameVector[i] = flat[i * totalFrames + frame];
    const logits = await runJoint(s, frameVector, prediction.output);
    const token = argmax(logits);
    if (token !== blank) {
      tokens.push(token);
      lastToken = token;
      hidden = prediction.hidden;
      cell = prediction.cell;
      prediction = null;
      emitted += 1;
    }
    if (token === blank || emitted === MAX_TOKENS_PER_STEP) {
      frame += 1;
      emitted = 0;
      if (onFrame) onFrame(frame, frames);
    }
  }
  return tokensToText(s.vocab, tokens);
}

function paddedToSecond(samples) {
  const padded = new Float32Array(SAMPLE_RATE);
  padded.set(samples);
  return padded;
}

async function runDecoder(s, token, hidden, cell) {
  const out = await s.decoder.run({
    x: { type: 'int64', data: BigInt64Array.from([BigInt(token)]), dims: [1, 1] },
    'h.1': { type: 'float32', data: hidden, dims: [1, 1, PREDICTION_HIDDEN] },
    'c.1': { type: 'float32', data: cell, dims: [1, 1, PREDICTION_HIDDEN] },
  });
  return {
    output: out.dec.data,
    hidden: out.h.data,
    cell: out.c.data,
  };
}

async function runJoint(s, frame, prediction) {
  const out = await s.joint.run({
    enc: { type: 'float32', data: frame, dims: [1, frame.length, 1] },
    dec: { type: 'float32', data: prediction, dims: [1, PREDICTION_HIDDEN, 1] },
  });
  return out.joint.data;
}

/**
 * Распознать запись целиком.
 *
 * @param {Buffer|Uint8Array} pcm 16-битный моно звук
 * @param {{ sampleRate?: number }} [options]
 * @returns {Promise<{ ok: boolean, text: string, ms: number, chunks: number, reason?: string }>}
 */
async function transcribeInner(pcm, options = {}) {
  const started = Date.now();
  transcribeCancelled = false;
  const rate = Number(options.sampleRate) || SAMPLE_RATE;
  if (rate !== SAMPLE_RATE) {
    return { ok: false, text: '', ms: 0, chunks: 0, reason: `движку нужен звук 16 кГц, пришло ${rate}` };
  }
  const state = status();
  if (!state.available) {
    return { ok: false, text: '', ms: 0, chunks: 0, reason: state.reason };
  }
  const samples = toSamples(pcm);
  if (!samples.length) return { ok: false, text: '', ms: 0, chunks: 0, reason: 'пустая запись' };

  let sessions;
  try {
    sessions = await openSessions();
  } catch (err) {
    return { ok: false, text: '', ms: 0, chunks: 0, reason: String(err?.message || err) };
  }

  const ranges = chunkRanges(samples, DEFAULT_MAX_SECONDS * SAMPLE_RATE);
  let text = '';
  let done = 0;
  for (const range of ranges) {
    // Отмена посреди длинной записи должна срабатывать сразу, а не после
    // последнего куска: иначе кнопка «Отменить» врёт.
    if (transcribeCancelled) {
      return { ok: false, text: '', ms: Date.now() - started, chunks: ranges.length, reason: 'отменено' };
    }
    const piece = samples.subarray(range.offset, range.offset + range.count);
    let chunkText;
    try {
      chunkText = await transcribeChunk(sessions, piece);
    } catch (err) {
      return { ok: false, text: '', ms: Date.now() - started, chunks: ranges.length, reason: String(err?.message || err) };
    }
    text = append(text, continuing(text, chunkText));
    done += 1;
    if (options.onProgress && ranges.length > 1) options.onProgress(done, ranges.length);
  }
  return { ok: true, text, ms: Date.now() - started, chunks: ranges.length };
}

/**
 * Скачать модель с проверкой размера и SHA-256.
 *
 * Файл сначала пишется с суффиксом `.unverified` и только после совпадения хеша
 * получает настоящее имя: иначе оборванная загрузка выглядела бы как готовая
 * модель, и приложение падало бы на чтении мусора.
 *
 * @param {{ onProgress?: (state: { received: number, total: number, file: string }) => void }} [options]
 */
async function downloadModel(options = {}) {
  const dir = modelDir();
  const files = modelFiles();
  const baseUrl = options.baseUrl || BASE_URL;
  const total = files.reduce((sum, file) => sum + file.size, 0);
  downloadState = { cancelled: false, received: 0, total };
  try {
    await downloadFiles({
      dir,
      files,
      baseUrl,
      missing: missingFiles(),
      state: downloadState,
      onProgress: options.onProgress,
    });
  } finally {
    downloadState = null;
  }
  unload();
  return status();
}

/** Прервать текущее распознавание (кнопка «Отменить» в плашке). */
function cancel() {
  // Без активного прохода отменять нечего: интерфейс спрашивает и получает
  // честное «нечего», а не бодрое «отменили».
  if (!transcribeActive) return false;
  transcribeCancelled = true;
  return true;
}

function cancelDownload() {
  if (!downloadState) return false;
  downloadState.cancelled = true;
  return true;
}

/** Подстановка сетей и модуля в тестах: настоящее ядро проверяется отдельно, руками. */
function setTestDeps(deps) {
  injected = deps || null;
  if (!deps) {
    ortCache = undefined;
    sessionCache = null;
  }
}

function reset() {
  transcribeCancelled = false;
  injected = null;
  ortCache = undefined;
  sessionCache = null;
  downloadState = null;
}

/**
 * Распознать запись, отметив проход активным: кнопка «Отменить» должна знать,
 * есть ли что отменять.
 */
async function transcribe(pcm, options = {}) {
  transcribeActive = true;
  try {
    return await transcribeInner(pcm, options);
  } finally {
    transcribeActive = false;
  }
}

module.exports = {
  BASE_URL,
  MODEL_BYTES,
  MODEL_FILES,
  PREPROCESSOR_NAME,
  REVISION,
  cancel,
  cancelDownload,
  downloadModel,
  modelDir,
  openSessions,
  preprocessorPath,
  reset,
  setTestDeps,
  status,
  toSamples,
  transcribe,
  transcribeChunk,
  unload,
  _internal: { argmax, hashFile, loadOrt, paddedToSecond },
};
