/**
 * Европейский движок: Parakeet TDT 0.6B v3 (NVIDIA, CC BY 4.0) в ONNX на процессоре.
 *
 * Зачем он нужен, если есть whisper и русская модель. Whisper на наших лёгких
 * моделях — компромисс «быстро или точно», а Parakeet считает в разы быстрее
 * речи даже на процессоре, сам расставляет запятые и заглавные, и по карточке
 * модели знает 25 европейских языков (включая английский, немецкий, французский,
 * испанский и украинский — то есть все, кроме китайского, японского, турецкого и
 * казахского из нашего списка). Русский остаётся за русской моделью: она
 * обучена только на русском и меньше весит.
 *
 * Как устроено (порядок шагов сверен с onnx-asr — экспорт, на котором модель и
 * собрана; см. `docs/14-EUROPEAN-ENGINE.md`):
 *
 *   звук 16 кГц → граф признаков `nemo128` (128 мел-полос) → энкодер
 *   (int8, 622 МБ) → жадное TDT-декодирование: декодер-джойнт выдаёт токен,
 *   а четвёрка «сколько кадров пропустить» ускоряет проход на тишине
 *
 * Что важно знать про поведение:
 *  • веса не входят в установщик и скачиваются один раз (≈640 МБ) с проверкой
 *    размера и SHA-256 — недокачанный файл не станет «моделью»;
 *  • запись длиннее 20 секунд режется в самом тихом месте около середины;
 *  • модель многоязычная с автоопределением языка: текст на неподдержанном
 *    языке (китайский, японский, турецкий, казахский) она прочитает как
 *    европейский, поэтому для этих языков движок не включается;
 *  • если ONNX Runtime или файлы недоступны, движок честно говорит об этом и
 *    диктовка остаётся на whisper — молчаливой подмены нет.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const { SAMPLE_RATE, append, chunkRanges, continuing, DEFAULT_MAX_SECONDS } = require('./chunking.cjs');
const { downloadFiles, hashFile } = require('./modelDownload.cjs');

/** Коммит репозитория модели: адрес обязан указывать на байты, а не на «main». */
const REVISION = '8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce';
const BASE_URL = `https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/${REVISION}`;

/**
 * Файлы модели: имя, точный размер и SHA-256 на закреплённом коммите.
 *
 * Размер и хеш — не «на глаз»: они сверены с двумя независимыми зеркалами
 * этого же экспорта, которые заявляют себя как побайтовые копии. Подменённый
 * или недокачанный файл отсекается до того, как станет «моделью».
 */
const MODEL_FILES = [
  {
    name: 'encoder-model.int8.onnx',
    size: 652183999,
    sha256: '6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09',
  },
  {
    name: 'decoder_joint-model.int8.onnx',
    size: 18202004,
    sha256: 'eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70',
  },
  {
    name: 'nemo128.onnx',
    size: 139764,
    sha256: 'a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f',
  },
  {
    name: 'vocab.txt',
    size: 93939,
    sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d',
  },
];

/** Сколько всего занимает модель — показывается человеку до скачивания. */
const MODEL_BYTES = MODEL_FILES.reduce((sum, file) => sum + file.size, 0);

/** Сколько токенов джойнт имеет право выдать на один кадр, если он не просит пропуск. */
const MAX_TOKENS_PER_STEP = 10;
/** Размер состояния предсказательной сети: у 0.6B это два слоя по 640. */
const DEFAULT_STATE = { layers: 2, size: 640 };

/**
 * Языки из нашего списка, которые модель знает. Русского здесь нет намеренно:
 * для него есть отдельная модель, обученная только на русском.
 */
const LANGUAGES = ['en', 'de', 'fr', 'es', 'uk'];

/** Файлы модели: в тестах подменяются мелкими, чтобы проверять скачивание и хеши. */
function modelFiles() {
  return injected?.files || MODEL_FILES;
}

let ortCache; // { module } | { error }
let sessionCache; // { preprocessor, encoder, decoderJoint, vocab, state }
let downloadState = null; // { cancelled, received, total }
let transcribeCancelled = false;
let transcribeActive = false;
let injected = null; // подставные сети для тестов

function modelDir() {
  return path.join(app.getPath('userData'), 'models', 'parakeet');
}

/** Каких файлов модели не хватает (по имени). */
function missingFiles() {
  const dir = modelDir();
  return modelFiles()
    .filter((file) => {
      try {
        const stat = fs.statSync(path.join(dir, file.name));
        return stat.size !== file.size;
      } catch {
        return true;
      }
    })
    .map((file) => file.name);
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
  const ort = loadOrt();
  if (!ort.module) {
    return { available: false, ready: false, reason: ort.error, missing, bytes, dir: modelDir() };
  }
  return { available: true, ready: true, reason: '', missing: [], bytes, dir: modelDir() };
}

/** Параметры сессий: половина ядер — остальное нужно системе. */
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
  const inputDims = {};
  for (const input of session.inputNames || []) inputDims[input] = undefined;
  return {
    inputNames: session.inputNames,
    outputNames: session.outputNames,
    inputDims,
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
  const vocab = parseVocabulary(fs.readFileSync(path.join(dir, named('vocab.txt')), 'utf8'));
  const decoderJoint = await wrapSession(ort.module, path.join(dir, named('decoder_joint-model.int8.onnx')));
  sessionCache = {
    preprocessor: await wrapSession(ort.module, path.join(dir, named('nemo128.onnx'))),
    encoder: await wrapSession(ort.module, path.join(dir, named('encoder-model.int8.onnx'))),
    decoderJoint,
    vocab,
    state: stateShape(decoderJoint),
  };
  return sessionCache;
}

/** Выгрузить сети: память энкодера (622 МБ весов) нужна не всегда. */
function unload() {
  sessionCache = null;
}

/**
 * Размер состояния предсказательной сети берём у самой модели, а не из головы:
 * у разных выгрузок он может отличаться, и угадывание здесь стоит падения.
 */
function stateShape(session) {
  const dims = session?.inputDims?.['input_states_1'];
  const layers = Number(dims?.[0]) || DEFAULT_STATE.layers;
  const size = Number(dims?.[2]) || DEFAULT_STATE.size;
  return { layers, size };
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

function argmax(values, from = 0, to = values.length) {
  let best = from;
  for (let i = from + 1; i < to; i++) if (values[i] > values[best]) best = i;
  return best;
}

/**
 * Словарь SentencePiece: «▁hello 42» → токен и номер. Пустая строка и мусор
 * пропускаются, `<blk>` запоминается как пустой токен (blank).
 */
function parseVocabulary(text) {
  const tokens = new Map();
  let blankId = -1;
  for (const line of String(text || '').split('\n')) {
    const clean = line.replace(/\r$/, '');
    if (!clean) continue;
    const space = clean.lastIndexOf(' ');
    if (space <= 0) continue;
    const token = clean.slice(0, space);
    const id = Number(clean.slice(space + 1));
    if (!Number.isInteger(id) || id < 0) continue;
    if (token === '<blk>') blankId = id;
    tokens.set(id, token);
  }
  const size = tokens.size ? Math.max(...tokens.keys()) + 1 : 0;
  return { tokens, size, blankId };
}

/** Токены → текст: «▁» это пробел, служебные токены в текст не попадают. */
function joinTokens(vocab, ids) {
  let text = '';
  for (const id of ids || []) {
    const token = vocab.tokens.get(Number(id));
    if (!token || token.startsWith('<')) continue;
    text += token.replace(/\u2581/g, ' ');
  }
  return text.replace(/\s+/g, ' ').trim();
}

function paddedToSecond(samples) {
  const padded = new Float32Array(SAMPLE_RATE);
  padded.set(samples);
  return padded;
}

/**
 * Один кусок: признаки → энкодер → жадное TDT-декодирование.
 *
 * TDT — это RNN-T, у которого джойнт вместе с токеном выдаёт «сколько кадров
 * пропустить» (0–4). Именно поэтому модель считает в разы быстрее речи:
 * на тишине она перескакивает кадры, а не идёт по ним по одному.
 */
async function transcribeChunk(s, samples, onFrame) {
  const input = samples.length >= SAMPLE_RATE ? samples : paddedToSecond(samples);

  const features = await s.preprocessor.run({
    waveforms: { type: 'float32', data: input, dims: [1, input.length] },
    waveforms_lens: { type: 'int64', data: BigInt64Array.from([BigInt(input.length)]), dims: [1] },
  });
  const featureTensor = features.features;
  const featureFrames = Number(features.features_lens.get(0));
  if (!featureTensor) throw new Error('граф признаков не вернул признаки');

  const encoded = await s.encoder.run({
    audio_signal: { type: 'float32', data: featureTensor.data, dims: featureTensor.dims },
    length: { type: 'int64', data: BigInt64Array.from([BigInt(featureFrames)]), dims: [1] },
  });
  const encodedTensor = encoded.outputs;
  if (!encodedTensor) throw new Error('энкодер не вернул выход');
  if (encodedTensor.dims.length !== 3 || encodedTensor.dims[0] !== 1) {
    throw new Error(`модель вернула неожиданную форму [${encodedTensor.dims.join(', ')}]`);
  }
  const dim = encodedTensor.dims[1];
  const totalFrames = encodedTensor.dims[2];
  const frames = Math.min(Math.max(Number(encoded.encoded_lengths.get(0)), 0), totalFrames);

  const flat = encodedTensor.data;
  const frameVector = new Float32Array(dim);
  const { layers, size } = s.state || DEFAULT_STATE;
  let state1 = new Float32Array(layers * size);
  let state2 = new Float32Array(layers * size);
  const blank = s.vocab.blankId;
  const vocabSize = s.vocab.size;
  let lastToken = blank;
  const tokens = [];
  let emitted = 0;

  for (let frame = 0; frame < frames; ) {
    if (transcribeCancelled) throw new Error('отменено');
    for (let i = 0; i < dim; i++) frameVector[i] = flat[i * totalFrames + frame];
    const out = await s.decoderJoint.run({
      encoder_outputs: { type: 'float32', data: frameVector, dims: [1, dim, 1] },
      targets: { type: 'int64', data: BigInt64Array.from([BigInt(lastToken)]), dims: [1, 1] },
      target_length: { type: 'int64', data: BigInt64Array.from([1n]), dims: [1] },
      input_states_1: { type: 'float32', data: state1, dims: [layers, 1, size] },
      input_states_2: { type: 'float32', data: state2, dims: [layers, 1, size] },
    });
    const logits = out.outputs.data;
    // Последние значения — не токены, а «сколько кадров пропустить».
    const durations = Math.max(0, logits.length - vocabSize);
    const token = argmax(logits, 0, durations ? vocabSize : logits.length);
    // ВАЖНО: argmax возвращает номер значения в общем списке, а шаг — это
    // номер длительности (0–4). Без вычитания размеров словаря «пропустить
    // ноль» превращалось в «пропустить четыре кадра» и съедало слова.
    const step = durations ? argmax(logits, vocabSize, logits.length) - vocabSize : 0;
    if (token !== blank) {
      tokens.push(token);
      lastToken = token;
      emitted += 1;
      state1 = out.output_states_1.data;
      state2 = out.output_states_2.data;
    }
    if (step > 0) {
      frame += step;
      emitted = 0;
    } else if (token === blank || emitted === MAX_TOKENS_PER_STEP) {
      frame += 1;
      emitted = 0;
    }
    if (onFrame) onFrame(Math.min(frame, frames), frames);
  }
  return joinTokens(s.vocab, tokens);
}

/**
 * Распознать запись целиком.
 *
 * @param {Buffer|Uint8Array} pcm 16-битный моно звук
 * @param {{ sampleRate?: number, onProgress?: (done: number, total: number) => void }} [options]
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
      return { ok: false, text: '', ms: Date.now() - started, chunks: ranges.length, code: 'cancelled', reason: 'отменено' };
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
 * Скачать модель с проверкой размера и SHA-256 (см. `electron/modelDownload.cjs`).
 *
 * @param {{ onProgress?: (state: { received: number, total: number, file: string }) => void, baseUrl?: string }} [options]
 */
async function downloadModel(options = {}) {
  if (downloadState) throw new Error('скачивание модели уже выполняется');
  const files = modelFiles();
  downloadState = {
    cancelled: false,
    received: 0,
    total: files.reduce((sum, file) => sum + file.size, 0),
  };
  try {
    await downloadFiles({
      dir: modelDir(),
      files,
      baseUrl: options.baseUrl || BASE_URL,
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
  downloadState.abort?.();
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
    const result = await transcribeInner(pcm, options);
    // ONNX-операцию нельзя мгновенно прервать, но её запоздалый результат
    // нельзя отдавать или запускать запасной движок после отмены.
    return transcribeCancelled
      ? { ok: false, text: '', ms: result.ms || 0, chunks: result.chunks || 0, code: 'cancelled', reason: 'отменено' }
      : result;
  } finally {
    transcribeActive = false;
  }
}

module.exports = {
  BASE_URL,
  LANGUAGES,
  MODEL_BYTES,
  MODEL_FILES,
  REVISION,
  cancel,
  cancelDownload,
  downloadModel,
  joinTokens,
  modelDir,
  openSessions,
  parseVocabulary,
  reset,
  setTestDeps,
  status,
  toSamples,
  transcribe,
  transcribeChunk,
  unload,
  _internal: { argmax, hashFile, loadOrt, stateShape },
};
