/**
 * Офлайн-распознавание речи через whisper.cpp.
 *
 * ZSpeakly ищет `whisper-cli.exe` (или whisper.exe / main.exe) в:
 *   1) resources/bin (рядом с установленным приложением),
 *   2) %APPDATA%\ZSpeakly\bin,
 *   3) PATH.
 * Модель — ggml-*.bin в %APPDATA%\ZSpeakly\models или resources/models.
 *
 * Если движка нет, ZSpeakly честно сообщает об этом: в приложении остаётся
 * Web Speech, а в браузерном превью — только его возможности.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { app } = require('electron');
const { writeWav } = require('./wav.cjs');

const BIN_NAMES = ['whisper-cli.exe', 'whisper.exe', 'main.exe', 'whisper-cli', 'whisper'];
const SERVER_NAMES = ['whisper-server.exe', 'whisper-server'];

function candidates(...paths) {
  return paths.filter(Boolean);
}

function findBinary(names = BIN_NAMES) {
  const roots = candidates(
    process.resourcesPath && path.join(process.resourcesPath, 'bin'),
    path.join(app.getPath('userData'), 'bin'),
    path.join(app.getAppPath(), 'bin'),
  );
  for (const dir of roots) {
    for (const name of names) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  // PATH
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of pathDirs) {
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        if (fs.existsSync(p)) return p;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

// Порядок, в котором модели устраивают диктовку: сначала то, что выбрал
// человек, потом разумные замены (turbo → small → base → tiny → medium).
const FALLBACK_ORDER = [
  'large-v3-turbo',
  'large-v3-turbo-q5_0',
  'small',
  'base',
  'tiny',
  'medium',
  'large-v3',
];

function findModel(preferred = 'small') {
  const dirs = candidates(
    process.resourcesPath && path.join(process.resourcesPath, 'models'),
    path.join(app.getPath('userData'), 'models'),
    path.join(app.getAppPath(), 'models'),
  );
  const wanted = [];
  const push = (id) => {
    const name = `ggml-${id}.bin`;
    if (!wanted.includes(name)) wanted.push(name);
  };
  if (preferred) push(preferred);
  // выбранная модель может быть не скачана — тогда берём любую подходящую,
  // иначе диктовка «молча не работает» при наличии рабочей модели на диске
  FALLBACK_ORDER.forEach(push);
  for (const dir of dirs) {
    for (const name of wanted) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * Модель VAD (Silero, ggml) — «гейт» перед распознаванием. Живёт рядом с
 * моделями; весит меньше мегабайта. С ней whisper не тратит время на тишину
 * и паузы, а на пустом звуке не выдумывает фразы.
 */
const VAD_NAMES = ['ggml-silero-v6.2.0.bin', 'ggml-silero-v5.1.2.bin', 'for-tests-silero-v6.2.0-ggml.bin'];

function findVadModel() {
  const dirs = candidates(
    process.resourcesPath && path.join(process.resourcesPath, 'models'),
    path.join(app.getPath('userData'), 'models'),
    path.join(app.getAppPath(), 'models'),
  );
  for (const dir of dirs) {
    for (const name of VAD_NAMES) {
      const p = path.join(dir, name);
      try {
        if (fs.existsSync(p)) return p;
      } catch {
        /* ignore */
      }
    }
    // Имя может отличаться версией Silero: подходит любой *silero*.bin.
    try {
      const hit = fs
        .readdirSync(dir)
        .filter((f) => /silero/i.test(f) && /\.bin$/i.test(f))
        .sort()
        .pop();
      if (hit) return path.join(dir, hit);
    } catch {
      /* папки может не быть */
    }
  }
  return null;
}

/**
 * Размер окна энкодера для конкретного файла: 1500 кадров — это 30 секунд,
 * и whisper считает их всегда, даже для фразы из двух слов. Для короткой
 * записи окно можно урезать с запасом (75 кадров на секунду + 50), и ответ
 * приходит в разы быстрее: на замере 3 секунды речи — 2,5 с → 0,73 с.
 * Для длинных записей окно не трогаем: там обрезка съела бы текст.
 */
/**
 * Сколько потоков отдать whisper.
 *
 * `os.cpus().length` — это логические потоки. На 4 ядрах с Hyper-Threading их
 * восемь, и whisper с `-t 8` считает МЕДЛЕННЕЕ, чем с `-t 4`: потоки дерутся за
 * одни и те же физические ядра. Поэтому на многоядерных машинах берём примерно
 * половину логических (это и есть число физических ядер), но не меньше двух и
 * не больше восьми.
 */
function threadCount() {
  const logical = (require('node:os').cpus() || []).length || 4;
  if (logical <= 4) return Math.max(1, logical);
  return Math.max(2, Math.min(8, Math.round(logical / 2)));
}

/**
 * Сколько запросов сервер может считать одновременно. whisper.cpp умеет
 * несколько процессоров (`-p`), но на двух-четырёх ядрах это только драка за
 * CPU, поэтому параллелим лишь на явно многопоточных машинах.
 */
function processorCount() {
  const logical = (require('node:os').cpus() || []).length || 4;
  return logical >= 8 ? 2 : 1;
}

function computeAudioCtx(wavPath) {
  try {
    const bytes = Math.max(0, fs.statSync(wavPath).size - 44); // 44 — заголовок RIFF
    const seconds = bytes / 2 / 16000;
    if (!seconds || seconds > 20) return 0;
    return Math.max(200, Math.min(1500, Math.round(seconds * 75) + 50));
  } catch {
    return 0;
  }
}

/**
 * Аргументы whisper-cli. Вынесены отдельно, чтобы их можно было проверить
 * тестом: раньше набор флагов жил внутри transcribe() и нигде не проверялся.
 *
 * -mc 0 — не тянуть контекст предыдущего прохода: каждая диктовка независима,
 *         иначе whisper «додумывает» продолжение прошлой фразы;
 * -bs 1 — жадное декодирование: быстрее beam search, для диктовки разницы
 *         в тексте практически нет;
 * --vad — Silero отсекает тишину: 30 секунд записи с паузами не гоняют
 *         модель на пустом звуке.
 */
function cliArgs({
  modelPath,
  wavPath,
  lang = 'ru',
  threads = 4,
  prompt = '',
  vadModel = '',
  outBase = '',
  noContext = true,
  beamSize = 1,
  audioCtx = 0,
} = {}) {
  const args = [
    '-m', String(modelPath || ''),
    '-f', String(wavPath || ''),
    '-l', String(lang || 'auto'),
    '-t', String(Math.max(1, Number(threads) || 4)),
    '--no-timestamps',
    '-nt',
    '-np',
    '-sns',
    '-otxt',
    '-of', String(outBase || `${wavPath}.out`),
  ];
  if (noContext) args.push('-mc', '0');
  if (Number(beamSize) > 0) args.push('-bs', String(Number(beamSize)));
  // -ac: сколько кадров энкодера считать. По умолчанию модель всегда считает
  // 1500 кадров (30 секунд), даже если человек сказал три слова — именно
  // поэтому короткая фраза «думала» секунды. Для короткой записи окно
  // урезается с запасом, для длинной остаётся полным.
  if (Number(audioCtx) > 0) args.push('-ac', String(Math.min(1500, Math.round(Number(audioCtx)))));
  if (vadModel) {
    args.push(
      '--vad',
      '-vm', String(vadModel),
      // порог уверенности и минимальная тишина: пауза в полсекунды — уже граница
      '-vt', '0.5',
      '-vsd', '500',
      '-vp', '100',
    );
  }
  if (prompt) args.push('--prompt', String(prompt));
  return args;
}

function status(preferredModel = 'small') {
  const bin = findBinary();
  const model = findModel(preferredModel);
  const vadPath = findVadModel();
  return {
    available: Boolean(bin && model),
    bin,
    model,
    // чего именно не хватает — чтобы интерфейс мог объяснить это словами
    missing: !bin ? 'bin' : !model ? 'model' : '',
    reason: !bin ? 'whisper.cpp не найден' : !model ? 'модель ggml не найдена' : '',
    modelName: model ? path.basename(model) : '',
    // с VAD движок не тратит время на тишину: интерфейс может так и написать
    vad: vadPath || '',
    server: serverStatus(),
  };
}

// ── Серверный режим: модель остаётся в памяти между диктовками ──────────────
//
// whisper-cli каждый раз заново грузит модель: для turbo это 1–3 секунды до
// первого слова. Локальные диктовочные приложения держат модель загруженной —
// в комплекте whisper.cpp есть whisper-server, который это умеет. Включается
// настройкой «Держать модель в памяти»; если сервера в комплекте нет или он не
// поднялся, всё честно возвращается к обычному запуску whisper-cli.

let serverState = null; // { proc, port, modelPath, readyAt }
let serverCooldownUntil = 0;

function serverBinary() {
  return findBinary(SERVER_NAMES);
}

function serverStatus() {
  const running = Boolean(serverState && serverState.proc && serverState.proc.exitCode === null);
  return {
    available: Boolean(serverBinary()),
    running,
    // ready — сервер уже ответил на запрос, значит модель в памяти и можно
    // считать без холодного старта. running без ready = ещё грузит веса.
    ready: Boolean(running && serverState.ready === true),
    warming: Boolean(warming),
    port: serverState?.port || 0,
    model: serverState?.modelPath ? path.basename(serverState.modelPath) : '',
    processors: serverState?.processors || 1,
    // последний проход: режим и время — видно в диагностике, а не «на глаз»
    last: lastRun ? { ...lastRun } : null,
  };
}

// Последний проход распознавания: режим (server/cli), время и число фрагментов.
let lastRun = null;
function rememberRun(mode, ms, parts) {
  lastRun = { mode, ms: Math.round(ms), parts: parts || 1, at: Date.now() };
}

let warming = false;

function stopServer() {
  if (!serverState) {
    warmScheduledFor = '';
    return;
  }
  const { proc } = serverState;
  serverState = null;
  warming = false;
  try {
    proc?.kill();
  } catch {
    /* ignore */
  }
}

function httpJson({ port, method = 'GET', urlPath, body, headers = {}, timeout = 60000 }) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, headers, timeout },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try {
            data = JSON.parse(text);
          } catch {
            data = null;
          }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text, data });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('таймаут сервера распознавания')));
    req.on('error', (err) => resolve({ ok: false, status: 0, text: '', data: null, error: err.message }));
    if (body) req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Запустить whisper-server и дождаться готовности. Возвращает state или null;
 * повторный вызов (без VAD-флагов) нужен, если сборка whisper.cpp не знает --vad.
 */
async function startServer(bin, args, { port, modelPath, deadlineMs = 20000 }) {
  let proc;
  try {
    proc = spawn(bin, args, { windowsHide: true });
  } catch {
    return null;
  }
  const state = { proc, port, modelPath };
  serverState = state;
  let stderr = '';
  proc.stderr?.on('data', (d) => {
    stderr += String(d);
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });
  proc.on('error', () => {
    if (serverState === state) serverState = null;
  });

  // Готовность: сервер начинает отвечать на GET /. Модель грузится секунды —
  // и на слабом ПК с медленным диском это легко больше восьми. Раньше здесь
  // стоял жёсткий лимит 8 с, после которого сервер считался «не поднялся» и
  // на пять минут запрещался: в итоге КАЖДАЯ диктовка шла через whisper-cli с
  // холодной загрузкой весов — то самое «полминуты на одну фразу». Ждём
  // столько, сколько нужно модели, и ждём в фоне: диктовка идёт через CLI,
  // никто не блокируется.
  const deadline = Date.now() + Math.max(4000, Number(deadlineMs) || 20000);
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break;
    const ping = await httpJson({ port, urlPath: '/', timeout: 1500 });
    if (ping.status) return state;
    await sleep(250);
  }
  if (serverState === state) stopServer();
  return null;
}

/**
 * Сколько ждать загрузку весов: большие модели на слабом диске грузятся
 * заметно дольше. Ждём в фоне, поэтому лишнее ожидание ничего не стоит.
 */
function modelLoadBudgetMs(modelPath) {
  const name = String(modelPath || '').toLowerCase();
  if (/(large|turbo)/.test(name)) return 90000;
  if (/(medium|small)/.test(name)) return 45000;
  return 20000; // tiny/base
}

/** Аргументы whisper-server: те же по смыслу, что у CLI. */
function serverArgs({ modelPath, port, threads, vadModel, processors = 1 }) {
  const args = [
    '-m', modelPath,
    '--host', '127.0.0.1',
    '--port', String(port),
    '-t', String(threads),
    // -p: сколько запросов сервер считает параллельно. Длинную диктовку
    // режем на части — на многопоточной машине они считаются одновременно.
    '-p', String(Math.max(1, Number(processors) || 1)),
    // -mc 0: не тащить контекст прошлых фраз — диктовки независимы, а лишний
    //        контекст ещё и замедляет декодер;
    // -bs 1 -bo 1: жадное декодирование вместо перебора вариантов — для
    //        диктовки разницы в тексте нет, а скорость заметно выше.
    '-mc', '0',
    '-bs', '1',
    '-bo', '1',
    '-nt',
    '-sns',
  ];
  if (vadModel) {
    args.push('--vad', '-vm', vadModel, '-vt', '0.5', '-vsd', '500', '-vp', '100');
  }
  return args;
}

/** Поднять whisper-server на свободном порту и дождаться готовности. */
async function ensureServer(modelPath, { threads = 4 } = {}) {
  if (Date.now() < serverCooldownUntil) return null;
  const bin = serverBinary();
  if (!bin) return null;
  if (serverState && serverState.modelPath === modelPath && serverState.proc?.exitCode === null) {
    // Сервер уже есть. Готовый — отдаём как есть, а тот, что ещё грузит веса,
    // не выдаём за готовый: иначе вызывающий сделает запрос в пустоту и решит,
    // что модель прогрета.
    return serverState.ready ? serverState : null;
  }
  stopServer();
  const port = 17800 + Math.floor(Math.random() * 400);
  const vadModel = findVadModel();
  const deadlineMs = modelLoadBudgetMs(modelPath);
  warming = true;
  try {
    // Цепочка фолбэков для старых сборок whisper.cpp: сначала полный набор,
    // потом без VAD, потом совсем простой (флаги декодирования могли не
    // появиться в старых версиях). Порядок важен: каждый следующий шаг теряет
    // скорость или точность, поэтому он только как крайняя мера.
    const processors = processorCount();
    const attempts = [
      serverArgs({ modelPath, port, threads, vadModel, processors }),
      serverArgs({ modelPath, port, threads, vadModel: '', processors }),
      serverArgs({ modelPath, port, threads, vadModel: '', processors: 1 }),
      ['-m', modelPath, '--host', '127.0.0.1', '--port', String(port), '-t', String(threads), '-nt'],
    ];
    for (const args of attempts) {
      // eslint-disable-next-line no-await-in-loop
      const state = await startServer(bin, args, { port, modelPath, deadlineMs });
      if (state) {
        state.ready = true;
        state.processors = processors;
        return state;
      }
    }
    // Не поднялся. Пауза короткая: раньше 5 минут запрета означали, что после
    // одного неудачного старта ВСЕ диктовки шли с холодной загрузкой модели.
    serverCooldownUntil = Date.now() + 20000;
    return null;
  } finally {
    warming = false;
  }
}

/**
 * Прогрев: заранее поднять whisper-server с моделью, чтобы первая диктовка
 * после запуска приложения не платила за загрузку модели.
 */
async function warm(model) {
  // Явный прогрев (кнопка или старт приложения) не должен упираться в паузу
  // после прошлой неудачи: человек нажал — значит, надо попробовать снова.
  serverCooldownUntil = 0;
  const modelPath = findModel(model);
  if (!modelPath) return { ok: false, reason: 'модель не найдена' };
  if (!serverBinary()) return { ok: false, reason: 'в комплекте нет whisper-server' };
  const threads = threadCount();
  const server = await ensureServer(modelPath, { threads });
  if (!server) return { ok: false, reason: 'whisper-server не поднялся' };
  // Первый запрос к серверу всегда дольше: он строит вычислительные графы
  // (на замере — 2,5 с против 0,7 с у следующих). Поэтому «прогрев» — это не
  // только запуск процесса: делаем пустой проход на тишине, чтобы человек не
  // платил эти секунды своей первой фразой.
  await warmupInference(server).catch(() => {});
  return { ok: true, port: server.port, warmed: true };
}

/** Пустой проход по тишине: строит графы сервера заранее. */
async function warmupInference(server) {
  const samples = 16000; // 1 секунда
  const pcm = Buffer.alloc(samples * 2);
  const wav = writeWav(pcm, 16000);
  const { body, contentType } = multipart(
    {
      language: 'ru',
      prompt: '',
      temperature: '0.0',
      response_format: 'json',
      no_timestamps: 'true',
      audio_ctx: '200',
    },
    { name: 'file', filename: 'warmup.wav', buffer: wav },
  );
  await httpJson({
    port: server.port,
    method: 'POST',
    urlPath: '/inference',
    body,
    headers: { 'Content-Type': contentType, 'Content-Length': body.length },
    timeout: 30000,
  });
}

function multipart(fields, fileField) {
  const boundary = `----zspeakly${Date.now().toString(16)}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fileField.name}"; filename="${fileField.filename}"\r\n` +
        'Content-Type: audio/wav\r\n\r\n',
    ),
  );
  parts.push(fileField.buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Один запрос к уже поднятому серверу. Возвращает текст или null. */
/**
 * Фоновый прогрев сервера. Ждём, пока закончится текущий проход: пока
 * whisper-cli считает, второй процесс только отнимает ядра. Попытка одна
 * за раз, с паузой: если сервер не поднимается, не молотим впустую.
 */
let warmTimer = null;
let warmScheduledFor = '';
function scheduleServerWarm(modelPath, threads) {
  if (warmTimer || warmScheduledFor === modelPath) return;
  warmScheduledFor = modelPath;
  const tick = () => {
    if (isBusy()) {
      warmTimer = setTimeout(tick, 400);
      return;
    }
    warmTimer = null;
    if (Date.now() < serverCooldownUntil) {
      warmScheduledFor = '';
      return;
    }
    ensureServer(modelPath, { threads })
      .catch(() => {})
      .finally(() => {
        warmScheduledFor = '';
      });
  };
  warmTimer = setTimeout(tick, 300);
}

async function transcribeViaServer(wavPath, { lang = 'ru', prompt = '', timeout = 120000, threads = 4, modelPath } = {}) {
  // ВАЖНО: в проходе распознавания сервер не ждём. Раньше здесь стоял
  // ensureServer() с ожиданием до 8 секунд — и если сервер не поднимался,
  // короткая фраза «думала» эти 8 секунд, а потом шла в обычный whisper-cli.
  // Теперь берём уже прогретый сервер, а если его нет — сразу CLI, поднимая
  // сервер в фоне для следующей диктовки.
  const ready = serverStatus();
  if (!ready.running || !serverState || serverState.modelPath !== modelPath) {
    // Поднимаем сервер для СЛЕДУЮЩЕЙ диктовки, но не одновременно с текущим
    // проходом: два процесса whisper делят ядра и оба становятся медленнее.
    scheduleServerWarm(modelPath, threads);
    return null;
  }
  const server = serverState;
  const startedAt = Date.now();
  const audioCtx = computeAudioCtx(wavPath);
  const audio = fs.readFileSync(wavPath);
  const { body, contentType } = multipart(
    {
      language: lang || 'auto',
      prompt: prompt || '',
      temperature: '0.0',
      response_format: 'json',
      'no_timestamps': 'true',
      // Параметры декодирования на каждый запрос: сервер их принимает
      // (examples/server/server.cpp) и без них берёт свои значения по
      // умолчанию — с перебором вариантов и контекстом прошлых фраз.
      max_context: '0',
      beam_size: '1',
      best_of: '1',
      // -ac: для короткой фразы считаем меньше кадров энкодера — это и есть
      // та самая разница «0,7 с против 2,5 с» на замерах с whisper-cli.
      ...(audioCtx > 0 ? { audio_ctx: String(audioCtx) } : {}),
    },
    { name: 'file', filename: path.basename(wavPath), buffer: audio },
  );
  const res = await httpJson({
    port: server.port,
    method: 'POST',
    urlPath: '/inference',
    body,
    headers: { 'Content-Type': contentType, 'Content-Length': body.length },
    timeout,
  });
  if (!res.ok) {
    // сервер мог упасть — следующий раз пойдём обычным путём
    if (!res.status) {
      stopServer();
      serverCooldownUntil = Date.now() + 60 * 1000;
    }
    return null;
  }
  const text = String(res.data?.text || res.text || '').trim();
  return { text, ms: Date.now() - startedAt };
}

/**
 * Текущий проход распознавания. Нужен, чтобы:
 *  - отменить долгий проход по кнопке «Отменить»;
 *  - не держать два whisper-процесса одновременно: каждый ест сотни
 *    мегабайт под модель, и на слабой машине это выглядело как «зажрал
 *    оперативку и ничего не распознал».
 */
let activeRun = null;

function isBusy() {
  return Boolean(activeRun);
}

/**
 * Отменить активный проход. Возвращает true, если что-то действительно
 * прервали. Ожидающий промис transcribe() завершится с code:'cancelled'.
 */
function cancel(reason = 'распознавание отменено') {
  const run = activeRun;
  if (!run) return false;
  activeRun = null;
  run.cancelled = true;
  try {
    run.child?.kill();
  } catch {
    /* ignore */
  }
  try {
    run.req?.destroy();
  } catch {
    /* ignore */
  }
  try {
    run.finish({ ok: false, text: '', code: 'cancelled', reason });
  } catch {
    /* ignore */
  }
  return true;
}

/**
 * Транскрипция wav-файла (16 kHz mono PCM).
 * Возвращает { ok, text, segments }.
 */
function transcribe(wavPath, { lang = 'ru', model = 'small', prompt = '', timeout = 120000, keepLoaded = false, vad = '', useVad = true } = {}) {
  return new Promise((resolve) => {
    const callStarted = Date.now();
    const bin = findBinary();
    const modelPath = findModel(model);
    if (!bin || !modelPath) {
      resolve({ ok: false, text: '', reason: 'whisper.cpp недоступен' });
      return;
    }
    const threads = threadCount();

    // Серверный режим: модель уже в памяти — текст приходит без холодного старта.
    if (keepLoaded) {
      transcribeViaServer(wavPath, { lang, prompt, timeout, threads, modelPath }).then((fast) => {
        // Пустой ответ сервера — это тоже ответ: повторять тот же проход через
        // whisper-cli значило бы ждать вдвое дольше и грузить модель второй раз.
        if (fast) {
          rememberRun('server', fast.ms || 0, 1);
          resolve({
            ok: Boolean(fast.text),
            text: fast.text || '',
            mode: 'server',
            ms: fast.ms || 0,
            code: fast.text ? undefined : 'empty',
          });
        } else {
          runCli();
        }
      });
      return;
    }
    runCli();

    function runCli() {

    // Набор флагов живёт в cliArgs(): его проверяют тесты, а не «на глаз».
    // -np: без служебного вывода, -sns: подавляем токены «не речь».
    const vadModel = useVad === false ? '' : vad || findVadModel() || '';
    const audioCtx = computeAudioCtx(wavPath);
    const args = cliArgs({
      modelPath,
      wavPath,
      lang,
      threads,
      prompt,
      vadModel,
      audioCtx,
      outBase: `${wavPath}.out`,
    });

    const child = spawn(bin, args, { windowsHide: true });
    let stderr = '';
    let stdout = '';
    let settled = false;
    const run = { child, finish: null, cancelled: false };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeRun === run) activeRun = null;
      // Сколько занял именно этот проход: цифру видно в диагностике и HUD,
      // иначе «медленно» остаётся разговором без доказательств.
      const ms = Date.now() - callStarted;
      if (value && value.ok !== undefined) rememberRun(value.mode || 'cli', ms, 1);
      resolve(value && typeof value === 'object' ? { ms, mode: value.mode || 'cli', ...value } : value);
    };
    run.finish = finish;
    activeRun = run;
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({ ok: false, text: '', code: 'timeout', reason: 'таймаут распознавания' });
    }, timeout);

    // Один повтор без VAD: флаг поддержан не всеми сборками whisper.cpp.
    function retryWithoutVad() {
      clearTimeout(timer);
      if (activeRun === run) activeRun = null;
      const again = cliArgs({
        modelPath,
        wavPath,
        lang,
        threads,
        prompt,
        vadModel: '',
        audioCtx: computeAudioCtx(wavPath),
        outBase: `${wavPath}.out`,
      });
      const child2 = spawn(bin, again, { windowsHide: true });
      let err2 = '';
      child2.stderr?.on('data', (d) => {
        err2 += d.toString();
        if (err2.length > 8000) err2 = err2.slice(-8000);
      });
      child2.on('error', (err) => finish({ ok: false, text: '', reason: err.message }));
      child2.on('close', (code2) => {
        try {
          const txt = `${wavPath}.out.txt`;
          if (fs.existsSync(txt)) {
            const text = fs.readFileSync(txt, 'utf8').trim();
            fs.unlinkSync(txt);
            if (text) {
              finish({ ok: true, text, code: code2 });
              return;
            }
          }
        } catch {
          /* файл мог не появиться */
        }
        finish({ ok: false, text: '', code: 'empty', reason: err2.slice(-400) || `код ${code2}` });
      });
    }

    child.stderr.on('data', (d) => {
      stderr += d.toString();
      // старые сборки whisper.cpp пишут расшифровку в stderr, а не в файл
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > 40000) stdout = stdout.slice(-40000);
    });
    child.on('error', (err) => {
      finish({ ok: false, text: '', reason: err.message });
    });
    child.on('close', (code) => {
      // 1) файл -otxt, если сборка его пишет
      try {
        const txt = `${wavPath}.out.txt`;
        if (fs.existsSync(txt)) {
          const text = fs.readFileSync(txt, 'utf8').trim();
          fs.unlinkSync(txt);
          if (text) {
            finish({ ok: true, text, code });
            return;
          }
        }
      } catch (err) {
        finish({ ok: false, text: '', reason: err.message });
        return;
      }
      // 2) вывод процесса: убираем служебные строки whisper.cpp
      const fromLog = (blob) =>
        blob
          .split(/\r?\n/)
          .map((line) => line.replace(/^\s*\[[^\]]*\]\s*/, '').trim())
          .filter((line) => line)
          .filter(
            (line) =>
              !/^(whisper_|ggml_|system_info|main:|output_|load_|mem_|init:)/i.test(line) &&
              !/^error:/i.test(line) &&
              !/^\s*(warning|using|processing|auto-detected)/i.test(line) &&
              // служебные строки whisper-cli: read_audio_data: …, miniaudio, …
              !/read_audio_data|miniaudio|trying to|failed to|audio data/i.test(line) &&
              // общий признак лога «идентификатор_с_подчёркиванием: текст»
              !/^[a-z0-9]*_[a-z0-9_]*\s*:/i.test(line),
          )
          .join(' ')
          .trim();
      const text = fromLog(stdout) || fromLog(stderr);
      if (text) {
        finish({ ok: true, text, code });
        return;
      }
      if (run.cancelled) {
        finish({ ok: false, text: '', code: 'cancelled', reason: 'распознавание отменено' });
        return;
      }
      const reason = (stderr || stdout).slice(-400).trim();
      // Старая сборка whisper.cpp не знает про --vad: не оставляем человека
      // без диктовки, повторяем проход без распознавания тишины.
      // Флаги VAD могут быть незнакомы старой сборке, а формат VAD-модели —
      // не совпасть с ней же. В обоих случаях повторяем проход без VAD.
      const vadTrouble =
        /unknown argument|invalid argument|unrecognized/i.test(reason) ||
        (/vad/i.test(reason) && /(fail|wrong shape|invalid|error)/i.test(reason));
      if (vadModel && !run.cancelled && vadTrouble) {
        retryWithoutVad();
        return;
      }
      finish({
        ok: false,
        text: '',
        code: 'empty',
        reason: reason || `whisper.cpp завершился с кодом ${code}`,
      });
    });
    }
  });
}

/**
 * Быстрая оценка записи по сырому PCM (16 бит, моно). Нужна, чтобы не гонять
 * whisper на тишине: он в таком случае выдаёт «Спасибо за просмотр» или
 * «Продолжение следует». Возвращает громкость в тех же единицах, что и сэмплы.
 */
function analysePcm(raw, sampleRate = 16000) {
  const total = Math.floor(raw.length / 2);
  if (!total) return { samples: 0, seconds: 0, rms: 0, peak: 0 };
  let sum = 0;
  let peak = 0;
  let count = 0;
  // каждый четвёртый сэмпл — этого достаточно для оценки громкости
  const step = 4;
  for (let i = 0; i < total; i += step) {
    const v = raw.readInt16LE(i * 2);
    const abs = Math.abs(v);
    if (abs > peak) peak = abs;
    sum += v * v;
    count += 1;
  }
  return {
    samples: total,
    seconds: total / sampleRate,
    rms: Math.round(Math.sqrt(sum / Math.max(1, count))),
    peak,
  };
}

/**
 * Обрезает тишину по краям записи, оставляя небольшой запас до и после речи.
 * Whisper хуже распознаёт, когда половина файла — пауза: на длинных хвостах он
 * «додумывает» фразы. Заодно меньше работы движку.
 */
function trimSilence(raw, sampleRate = 16000, { threshold = 200, leadMs = 150, tailMs = 250 } = {}) {
  const total = Math.floor(raw.length / 2);
  if (!total) return raw;
  let first = -1;
  let last = -1;
  for (let i = 0; i < total; i += 1) {
    if (Math.abs(raw.readInt16LE(i * 2)) > threshold) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return raw; // речи нет — пусть решает analysePcm
  const lead = Math.round((sampleRate * leadMs) / 1000);
  const tail = Math.round((sampleRate * tailMs) / 1000);
  const from = Math.max(0, first - lead);
  const to = Math.min(total, last + tail);
  if (from === 0 && to === total) return raw;
  return raw.subarray(from * 2, to * 2);
}

/**
 * Режет запись на фрагменты по длинным паузам (простой VAD по громкости).
 *
 * Зачем: whisper обрабатывает файл целиком и на длинной диктовке хуже держит
 * конец и путает фразы через паузу в несколько секунд. Режем по паузам длиннее
 * `minPauseMs`, каждый фрагмент распознаём отдельно и склеиваем текстом.
 * Тишина внутри фразы (обычная пауза между словами) границей не считается.
 */
function splitBySilence(raw, sampleRate = 16000, { minPauseMs = 700, maxSeconds = 25, threshold = 200 } = {}) {
  const total = Math.floor(raw.length / 2);
  if (!total) return [raw];
  const frameMs = 20;
  const frame = Math.round((sampleRate * frameMs) / 1000);
  if (!frame) return [raw];
  const frames = Math.floor(total / frame);
  if (frames < 2) return [raw];

  const voiced = new Array(frames);
  for (let f = 0; f < frames; f += 1) {
    let peak = 0;
    const start = f * frame;
    for (let i = start; i < start + frame; i += 1) {
      const abs = Math.abs(raw.readInt16LE(i * 2));
      if (abs > peak) peak = abs;
    }
    voiced[f] = peak > threshold;
  }

  const pauseFrames = Math.max(2, Math.round(minPauseMs / frameMs));
  const speech = [];
  let from = -1;
  let lastVoiced = -1;
  for (let f = 0; f < frames; f += 1) {
    if (voiced[f]) {
      if (from < 0) from = f;
      lastVoiced = f;
    } else if (from >= 0 && f - lastVoiced >= pauseFrames) {
      speech.push([from, lastVoiced]);
      from = -1;
      lastVoiced = -1;
    }
  }
  if (from >= 0) speech.push([from, lastVoiced]);
  if (!speech.length) return [raw];

  // запас по краям, чтобы не срезать начало и конец слова
  const leadFrames = Math.round(300 / frameMs);
  const tailFrames = Math.round(400 / frameMs);
  const maxFrames = Math.max(1, Math.round((maxSeconds * 1000) / frameMs));
  const parts = [];
  for (const [a, b] of speech) {
    let start = Math.max(0, a - leadFrames);
    const end = Math.min(frames, b + tailFrames);
    while (end - start > maxFrames) {
      parts.push([start, start + maxFrames]);
      start += maxFrames;
    }
    parts.push([start, end]);
  }
  if (parts.length < 2) return [raw];
  const out = [];
  for (const [a, b] of parts) {
    const slice = raw.subarray(a * frame * 2, Math.min(total, b * frame) * 2);
    if (slice.length >= frame * 2) out.push(slice);
  }
  return out.length ? out : [raw];
}

// Что whisper любит «слышать» в тишине и на музыке. Убираем только целые
// фразы-галлюцинации: если человек правда сказал «спасибо за просмотр» вместе
// с остальным текстом — фраза не совпадёт целиком и останется.
const PHANTOM_PHRASES = [
  /^(продолжение следует|конец|спасибо за (просмотр|внимание)|подписывайтесь на канал|ставьте лайки|субтитры (сделал|сделаны|подготовил|редактор))[.\s!…]*$/i,
  /^(thank you for watching|thanks for watching|subscribe to (my|the) channel|like and subscribe|subtitles by)[.\s!…]*$/i,
];
function isPhantom(text) {
  const clean = String(text || '').trim();
  if (!clean || clean.length > 120) return false;
  return PHANTOM_PHRASES.some((re) => re.test(clean));
}

module.exports = {
  status,
  transcribe,
  cliArgs,
  computeAudioCtx,
  findVadModel,
  cancel,
  isBusy,
  findBinary,
  findModel,
  analysePcm,
  trimSilence,
  splitBySilence,
  isPhantom,
  serverStatus,
  stopServer,
  warm,
  multipart,
  transcribeViaServer,
  // проверяются тестами: по ним видно, что сервер поднимается с жадным
  // декодированием и что слабому диску даётся больше времени на веса
  serverArgs,
  modelLoadBudgetMs,
  threadCount,
  processorCount,
};
