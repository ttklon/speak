/**
 * ZSpeakly STT-движок с прозрачным фолбэком.
 *
 * Приоритет:
 *  1) whisper.cpp через main-процесс Electron (полностью офлайн, лучший вариант);
 *  2) Web Speech API (браузер, нужен интернет и разрешение на микрофон);
 *  3) если распознавать нечем — честная ошибка с подсказкой. Выдуманного
 *     текста нет нигде: раньше браузерное превью «работало» на демо-движке
 *     и печатало заготовленные фразы, из-за чего легко было принять заглушку
 *     за настоящее распознавание.
 */

import { describeRecognitionError } from './errors.js';
import { startPcmRecording } from '../audio/pcmRecorder.js';
import { createSpeechTracker, mergeOverlap, shouldPreChunk } from './chunks.js';

const SpeechRecognitionImpl =
  typeof window !== 'undefined'
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null;

export const hasWebSpeech = Boolean(SpeechRecognitionImpl);
// В Electron моста достаточно, чтобы отличить настоящую сборку от превью.
const isElectronShell = () =>
  typeof window !== 'undefined' && Boolean(window.zspeakly?.isElectron);
// нужен именно PCM-канал: канал transcribe(wav) удалён из main, у рендерера
// нет записи звука в файл, и вызов был мёртвым
export const hasNativeStt = () =>
  typeof window !== 'undefined' && Boolean(window.zspeakly?.native?.transcribePcm);

/**
 * Последняя запись — чтобы её можно было переспросить точным проходом.
 *
 * Ошибку видно сразу после вставки, но второй текст раньше можно было получить
 * только повторив фразу голосом. Держим ровно одну запись (до 40 секунд — это
 * меньше 1,3 МБ) и отпускаем предыдущую: хранить историю звука на устройстве
 * человек не просил.
 */
const LAST_AUDIO_LIMIT_MS = 40000;
let lastAudio = null;

export function lastRecordedAudio() {
  return lastAudio;
}

function rememberRecordedAudio(pcm, durationMs, lang) {
  if (!pcm?.length || !(durationMs >= 350) || durationMs > LAST_AUDIO_LIMIT_MS) {
    lastAudio = null;
    return;
  }
  // Копия: исходный буфер переиспользуется рекордером и после остановки
  // превратился бы в мусор.
  lastAudio = { pcm: Int16Array.from(pcm), durationMs: Math.round(durationMs), lang: lang || 'ru' };
}

/**
 * Чем считала прошлая диктовка: 'server' (прогретый whisper.cpp в памяти),
 * 'cli' (холодный запуск) или '' (ещё не знаем). От этого зависит, стоит ли
 * резать запись заранее: на холодном движке каждый кусок — это снова загрузка
 * весов, и нарезка сделала бы диктовку медленнее.
 */
let lastMode = '';

/**
 * Почему запись не дала текста — и что с этим делать.
 *
 * Вынесено из кода движка, чтобы тест мог проверить каждую подсказку: она
 * обязана называть раздел, который в настройках действительно есть.
 */
export const EMPTY_RESULT_MESSAGES = {
  silent: {
    title: 'В записи нет речи',
    hint: 'Микрофон не слышит голос: выберите устройство в «Настройки → Приложение → Устройство микрофона», а уровень проверьте там же — «Тест микрофона».',
  },
  phantom: {
    title: 'В записи не было речи',
    hint: 'Похоже, микрофон записал тишину или шум. Попробуйте ещё раз ближе к микрофону.',
  },
  'too-short': {
    title: 'Слишком короткая запись',
    hint: 'Говорите сразу после нажатия сочетания клавиш.',
  },
  default: {
    title: 'Движок не распознал речь',
    // «проверьте в настройках» человек выполнить не может: называем точные разделы
    hint: 'Скажите ещё раз ближе к микрофону. Если повторяется — проверьте модель в «Настройки → Диктовка → Модель распознавания», а устройство — в «Настройки → Приложение → Устройство микрофона».',
  },
};

export function engineName() {
  if (hasNativeStt()) return 'whisper.cpp (офлайн)';
  // Web Speech в Chrome отправляет звук на серверы Google — это не офлайн,
  // поэтому в названии движка честно написано про интернет.
  if (hasWebSpeech && !isElectronShell()) return 'Web Speech (нужен интернет)';
  if (isElectronShell()) return 'движок не установлен';
  return 'распознавание недоступно';
}

function createWebRecognizer({ lang, continuous, interimResults, onPartial, onFinal, onError, onEnd, onStart }) {
  const rec = new SpeechRecognitionImpl();
  rec.lang = lang;
  rec.continuous = continuous;
  rec.interimResults = interimResults;
  rec.maxAlternatives = 1;

  let finalText = '';
  let stopped = false;
  let closed = false;

  rec.onstart = () => { if (!closed) onStart?.(); };
  rec.onerror = (e) => { if (!closed) onError?.({ code: e.error, ...describeRecognitionError(e.error) }); };
  rec.onend = () => {
    if (closed) return;
    if (!stopped) {
      try {
        rec.start();
        return;
      } catch {
        /* ignore */
      }
    }
    closed = true;
    onEnd?.({ text: finalText });
  };
  rec.onresult = (event) => {
    if (closed) return;
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const res = event.results[i];
      if (res.isFinal) {
        finalText = [finalText, res[0].transcript.trim()].filter(Boolean).join(' ');
        onFinal?.({ text: finalText, last: res[0].transcript.trim() });
      } else {
        interim += res[0].transcript;
      }
    }
    onPartial?.({ text: finalText, interim });
  };

  return {
    kind: 'web',
    start() {
      stopped = false;
      closed = false;
      finalText = '';
      rec.start();
    },
    stop() {
      stopped = true;
      try {
        rec.stop();
        return true;
      } catch {
        return false;
      }
    },
    abort() {
      stopped = true;
      closed = true;
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
    },
    get text() {
      return finalText;
    },
  };
}

/**
 * Единая точка создания распознавателя.
 * Возвращает объект { kind, start, stop, abort, text }.
 */
export function createRecognizer(opts = {}) {
  const {
    lang = 'ru-RU',
    continuous = true,
    interimResults = true,
    onPartial,
    onFinal,
    onError,
    onEnd,
    onStart,
    onLevel,
    onNotice,
  } = opts;

  // Язык может зависеть от активного окна («в редакторе — английский»). Окно
  // узнаётся через доли секунды после старта записи, а первый проход движка
  // случается позже — на паузе или на остановке. Поэтому язык решаем один раз
  // при первом обращении: иначе куски одной фразы распознали бы разными
  // языками, и склейка превратилась бы в кашу.
  let resolvedLang = '';
  const langCode = () => {
    if (resolvedLang) return resolvedLang;
    let picked = '';
    try {
      picked = typeof opts.getLang === 'function' ? opts.getLang() : lang;
    } catch {
      picked = lang;
    }
    resolvedLang = String(picked || lang || 'ru').slice(0, 2);
    return resolvedLang;
  };

  // 1) Нативный whisper.cpp: пишем PCM в рендерере → main → whisper-cli.exe
  if (hasNativeStt()) {
    const native = window.zspeakly.native;
    let recorder = null;
    let text = '';
    let stopped = false;
    let aborted = false;
    let confirmedMs = 0;
    let preBroken = false;
    let preClosed = false;
    let wakeAbort;
    const abortSignal = new Promise((resolve) => { wakeAbort = resolve; });
    // живая расшифровка: whisper не отдаёт слова по мере речи, поэтому раз в
    // intervalMs отправляем накопленный звук заново и показываем, что вышло
    const streamInterval = Number(opts.streamIntervalMs) || 0;
    let streamTimer = null;
    let streamGen = 0;
    // «Считать, пока говорите»: на паузах уже сказанное уходит в движок, и
    // после остановки остаётся распознать только хвост. Это и есть разница
    // между «ждать двадцать секунд» и «ждать одно предложение».
    const tracker = createSpeechTracker();
    // Уже распознанный текст копится строкой: куски идут с перекрытием, и
    // каждый следующий надо склеить с предыдущим без дублей.
    let preText = '';
    let preCount = 0;
    let preMs = 0;
    let preChain = Promise.resolve();

    const stopStream = () => {
      streamGen += 1;
      if (streamTimer) clearTimeout(streamTimer);
      streamTimer = null;
    };

    const scheduleStream = () => {
      if (stopped || !streamInterval || !recorder) return;
      streamTimer = setTimeout(runStreamTick, streamInterval);
    };

    const runStreamTick = async () => {
      streamTimer = null;
      if (stopped || !recorder) return;
      // на паузе не тратим процессор: живой текст всё равно не изменится
      if (recorder.paused) {
        scheduleStream();
        return;
      }
      const gen = streamGen;
      let snap = null;
      try {
        snap = recorder.snapshot?.({ maxSeconds: 30 });
      } catch {
        snap = null;
      }
      // меньше секунды речи whisper почти всегда возвращает пустоту — зря греем CPU
      if (!snap?.pcm?.length || snap.durationMs < 900) {
        scheduleStream();
        return;
      }
      try {
        const res = await native.transcribePcm?.({
          pcm: snap.pcm,
          durationMs: snap.durationMs,
          lang: langCode(),
          model: opts.model || 'small',
          // словарь и экранный контекст — только для итогового прохода:
          // иначе промежуточный текст будет «умнее» финального
          useDictionary: false,
          contextPrompt: '',
          partial: true,
        });
        if (stopped || gen !== streamGen) return;
        if (res?.ok && String(res.text || '').trim()) {
          // truncated — распознан только хвост записи: интерфейс обязан
          // показать это, а не выдавать хвост за весь текст
          onPartial?.({
            text: String(res.text).trim(),
            interim: '',
            live: true,
            truncated: snap.truncated === true,
          });
        }
      } catch {
        /* промежуточный сбой не должен ломать диктовку */
      }
      scheduleStream();
    };

    /**
     * Кусок уже сказанного — в движок, не останавливая микрофон. Проходы идут
     * по очереди: два whisper на слабом ноутбуке делят ядра и оба медленнее.
     */
    const queuePreChunk = (cut) => {
      preChain = preChain.then(async () => {
        if (stopped || preBroken || preClosed || !recorder) return;
        // Отдаём чуть больше, чем «новый» звук: слово, разрезанное границей,
        // должно целиком попасть хотя бы в один кусок.
        const fromMs = Math.max(0, cut.fromMs - tracker.overlapMs);
        const snap = recorder.snapshot?.({ fromMs, toMs: cut.atMs, maxSeconds: 0 });
        if (!snap?.pcm?.length || snap.durationMs < 800) {
          preBroken = true;
          tracker.rollback(cut.fromMs);
          return;
        }
        try {
          const res = await native.transcribePcm?.({
            pcm: snap.pcm,
            durationMs: snap.durationMs,
            lang: langCode(),
            model: opts.model || 'small',
            // Словарь и экранный контекст — только для хвоста: на куске они
            // подсказывают движку то, чего в этом куске ещё не сказано.
            useDictionary: false,
            contextPrompt: '',
            pre: true,
          });
          // После таймаута/отмены ответ больше не относится к итоговой записи.
          if (preClosed || aborted) return;
          if (res?.mode) lastMode = res.mode;
          if (res?.ok && String(res.text || '').trim()) {
            confirmedMs = cut.atMs;
            preText = mergeOverlap(preText, String(res.text).trim());
            preCount += 1;
            preMs += Number(res.ms) || 0;
          } else {
            // Пусто — значит кусок не распознан. Возвращаем границу, иначе
            // этот звук не попадёт ни в кусок, ни в хвост.
            preBroken = true;
            tracker.rollback(cut.fromMs);
          }
        } catch {
          if (!preClosed && !aborted) {
            preBroken = true;
            tracker.rollback(cut.fromMs);
          }
        }
      });
    };

    return {
      kind: 'native',
      async start() {
        try {
          recorder = await startPcmRecording({
            deviceId: opts.deviceId || 'default',
            // сырой звук или «шумоподавление Windows» — решает настройка
            cleanupAudio: opts.micCleanup === true,
            isCancelled: () => aborted,
            onLevel: (v) => {
              onLevel?.(v);
              // Уровень микрофона — единственный сигнал, по которому видно
              // паузу. Дальше решает чистый модуль chunks.js: он скажет,
              // можно ли уже отдать кусок движку.
              if (preBroken || preClosed || aborted || !shouldPreChunk(lastMode)) return;
              const atMs = recorder
                ? Math.round((recorder.frames / (recorder.sampleRate || 16000)) * 1000)
                : 0;
              const cut = tracker.feed({ level: v, atMs });
              if (cut) queuePreChunk(cut);
            },
            // предролл «горячего микрофона»: звук до нажатия хоткея
            preroll: opts.preroll || null,
          });
          // Пользователь мог отменить, пока браузер спрашивал разрешение.
          if (aborted) {
            recorder?.abort?.();
            recorder = null;
            return;
          }
          // выбранный микрофон пропал — пишем с системного, но не молчим
          if (recorder?.fellBack) {
            onNotice?.({
              title: 'Микрофон из настроек не найден',
              description:
                'Записываю с системного. Выберите микрофон в «Настройки → Приложение → Устройство микрофона».',
              tone: 'warn',
              ttl: 9000,
            });
          }
          onStart?.();
          scheduleStream();
        } catch (err) {
          if (aborted) return;
          // нет микрофона или отказали в доступе — сообщаем честно
          // Причина от браузера (NotAllowedError, NotFoundError) важнее
          // технического «Permission denied» — человеку нужен следующий шаг.
          const named = err?.name === 'NotAllowedError' ? 'not-allowed' : err?.name === 'NotFoundError' ? 'audio-capture' : '';
          const described = named ? describeRecognitionError(named) : {
            title: 'Не удалось открыть микрофон',
            hint: 'Проверьте доступ к микрофону и устройство в «Настройки → Приложение → Устройство микрофона», затем попробуйте снова.',
          };
          onError?.({
            ...described,
            code: named || 'mic-failed',
            title: described.title || 'Микрофон недоступен',
            hint: described.hint || String(err?.message || err),
          });
          // НЕ пробрасываем исключение: провайдер ждёт промис, а не отказ,
          // иначе «не удалось начать запись» вместо причины от микрофона.
          return;
        }
      },
      async stop() {
        if (stopped) return { text };
        if (!recorder) {
          // Отпустили кнопку, пока система ещё открывает микрофон. Не ждём
          // неопределённое время разрешения: поздно полученный поток закроет
          // проверка aborted в start(), а новая запись сможет начаться сразу.
          aborted = true;
          stopped = true;
          preClosed = true;
          wakeAbort();
          stopStream();
          onError?.({
            code: 'mic-not-ready',
            title: 'Микрофон ещё не открылся',
            hint: 'Дождитесь разрешения на микрофон и попробуйте записать ещё раз.',
          });
          return { text: '', code: 'mic-not-ready' };
        }
        stopped = true;
        // недоработанный промежуточный запрос больше не нужен: финальный
        // проход по всей записи всё равно точнее. Раньше он не отменялся и
        // работал параллельно с итоговым — два whisper-процесса, двойная
        // память и вдвое дольше ожидание.
        stopStream();
        // Останавливаем микрофон сразу, а не после ожидания движка. Иначе во
        // время ожидания предварительного куска или отмены в диктовку попадает
        // речь, сказанная уже после отпускания кнопки.
        const { pcm, durationMs } = recorder.stop();
        // Досчитываем уже отправленный кусок: если оборвать его отменой, этот
        // звук пропадёт — он не попадёт ни в хвост, ни в результат.
        let preTimer;
        await Promise.race([preChain, abortSignal, new Promise((resolve) => { preTimer = setTimeout(resolve, 6000); })]);
        clearTimeout(preTimer);
        // Отправленная граница может ещё не быть подтверждена результатом.
        // С этого момента поздний ответ куска игнорируется, а хвост начинается
        // с последней подтверждённой границы, не с очереди отправки.
        preClosed = true;
        if (aborted) return { text: '', code: 'cancelled' };
        try {
          await Promise.race([native.cancelTranscribe?.(), abortSignal]);
        } catch {
          /* отмена — не ошибка */
        }
        if (aborted) return { text: '', code: 'cancelled' };
        if (!pcm?.length) {
          onError?.({ code: 'no-audio', title: 'Запись пустая', hint: 'Микрофон ничего не передал. Проверьте устройство в настройках.' });
          onEnd?.({ text: '' });
          return { text: '', reason: 'no-audio' };
        }
        if (durationMs < 350) {
          onError?.({ code: 'too-short', title: 'Слишком короткая запись', hint: 'Говорите сразу после нажатия и не останавливайте запись так быстро.' });
          onEnd?.({ text: '' });
          return { text: '', reason: 'too-short' };
        }
        let res;
        // подсказка с экрана берётся в последний момент: локальная модель могла
        // ответить уже после старта записи
        const contextPrompt =
          typeof opts.getContextPrompt === 'function' ? String(opts.getContextPrompt() || '') : '';
        // Что уже распознано заранее — то второй раз не считаем. После паузы
        // сюда попадает только хвост; без пауз предварительных кусков нет, и
        // хвост равен всей записи (поведение как раньше).
        const committedMs = Math.min(confirmedMs, durationMs);
        const RATE = 16000;
        // Хвост тоже с перекрытием: на его стыке с последним куском может быть
        // половина слова, и `mergeOverlap` снимет дубль.
        const tailFrom = Math.max(0, committedMs - tracker.overlapMs);
        const tailPcm =
          committedMs > 0
            ? pcm.subarray(Math.min(pcm.length, Math.round((tailFrom / 1000) * RATE)))
            : pcm;
        const tailMs = Math.max(0, durationMs - committedMs);
        // Хвост короче трети секунды — там нет слов, только дыхание: отдаём
        // то, что уже распознали, и не тратим проход движка.
        if (preText && tailPcm.length < RATE * 0.3) {
          rememberRecordedAudio(pcm, durationMs, langCode());
          text = preText;
          onFinal?.({ text, last: text });
          onEnd?.({
            text,
            ms: preMs,
            spoken: Math.round(durationMs / 100) / 10,
            mode: 'pre',
            parts: preCount,
            timeline: { preMs, preParts: preCount, tailMs: 0 },
            model: opts.model || '',
          });
          return { text };
        }
        try {
          // pcm уходит как Int16Array: main превращает его в сырые байты сам,
          // иначе whisper получает мусор вместо звука (был именно такой баг)
          res = await Promise.race([native.transcribePcm?.({
            pcm: tailPcm,
            durationMs: tailMs || durationMs,
            lang: langCode(),
            model: opts.model || 'small',
            // тумблер «Применять словарь при диктовке» управляет и подсказкой
            // whisper'у, и заменой слов в готовом тексте
            useDictionary: opts.useDictionary !== false,
            // Продолжение, а не новая фраза: хвост должен подхватить стиль и
            // термины уже распознанного куска.
            contextPrompt: preText ? `${preText} ${contextPrompt}`.trim() : contextPrompt,
          }), abortSignal.then(() => ({ ok: false, code: 'cancelled' }))]);
        } catch (err) {
          if (aborted) return { text: '', code: 'cancelled' };
          onError?.({ code: 'stt-failed', title: 'Распознавание не удалось', hint: String(err?.message || err) });
          onEnd?.({ text: '' });
          return { text: '', reason: String(err?.message || err) };
        }
        if (aborted || res?.code === 'cancelled') return { text: '', code: 'cancelled' };
        if (res?.mode) lastMode = res.mode;
        if (res?.ok && res.text) {
          rememberRecordedAudio(pcm, durationMs, langCode());
          // Полный текст — заранее распознанные куски плюс хвост. Один проход
          // по хвосту вместо всей фразы и есть выигрыш во времени.
          text = preText ? mergeOverlap(preText, res.text) : res.text;
          onFinal?.({ text, last: text });
          // ms — сколько заняло распознавание: показываем человеку, что движок
          // действительно работал, а не «проглотил» запись
          // spoken — сколько секунд человек реально говорил: по нему видно
          // «20 секунд речи за 3 секунды счёта», а не «обработка…»
          onEnd?.({
            text,
            ms: (Number(res.ms) || 0) + preMs,
            // «Сколько человек говорил» — это вся запись, а не только хвост:
            // иначе после паузы в отчёте появилось бы «1 с речи → 5 с ожидания».
            spoken: Math.round(durationMs / 100) / 10,
            // режим и разложение по этапам: по ним видно, платил ли человек за
            // холодную загрузку модели и сколько стоила подготовка звука
            mode: res.mode || '',
            parts: Number(res.chunks) || Number(res.timeline?.parts) || 1,
            timeline: {
              ...(res.timeline || {}),
              preMs,
              preParts: preCount,
              tailMs: Math.round(tailMs),
            },
            model: res.model || '',
            thorough: res.thorough === true,
            secondPass: res.secondPass === true,
            gainDb: Number(res.audio?.gainDb) || 0,
            pausesMs: Number(res.audio?.pausesMs) || 0,
          });
        } else if (preText) {
          rememberRecordedAudio(pcm, durationMs, langCode());
          // Хвост не распознался (шум, обрывок), но заранее посчитанное уже
          // есть: отдавать пустоту и «ничего не распознано» было бы потерей.
          text = preText;
          onFinal?.({ text, last: text });
          onEnd?.({
            text,
            ms: preMs,
            spoken: Math.round(durationMs / 100) / 10,
            mode: 'pre',
            parts: 1,
            timeline: { preMs, preParts: preCount, tailMs: Math.round(tailMs) },
            model: opts.model || '',
          });
        } else {
          const code = res?.code || 'stt-empty';
          onError?.(
            EMPTY_RESULT_MESSAGES[code] || {
              code: 'stt-empty',
              ...EMPTY_RESULT_MESSAGES.default,
              hint: res?.reason || EMPTY_RESULT_MESSAGES.default.hint,
            },
          );
          onEnd?.({ text: '' });
        }
        return { text };
      },
      /** Пауза посреди диктовки: микрофон открыт, звук не копится. */
      pause() {
        try {
          recorder?.pause?.();
        } catch {
          /* ignore */
        }
      },
      /** Продолжить запись после паузы. */
      resume() {
        try {
          recorder?.resume?.();
        } catch {
          /* ignore */
        }
      },
      get paused() {
        return Boolean(recorder?.paused);
      },
      abort() {
        aborted = true;
        preClosed = true;
        wakeAbort();
        stopped = true;
        stopStream();
        recorder?.abort?.();
        recorder = null;
        // отменяем и незавершённый проход распознавания
        try {
          native.cancelTranscribe?.();
        } catch {
          /* ignore */
        }
      },
      get text() {
        return text;
      },
    };
  }

  // 2) Web Speech: системный движок браузера (может отправлять звук в сеть).
  if (hasWebSpeech) {
    let active = null;
    let emitted = false;
    let ended = false;
    let aborted = false;
    let userStopped = false;
    let watchdog = null;
    let stopTimer = null;
    let stopPromise = null;
    let resolveStop = null;
    let endPayload = null;

    const clearTimers = () => {
      clearTimeout(watchdog);
      clearTimeout(stopTimer);
      watchdog = null;
      stopTimer = null;
    };
    const settle = (payload, { reportEmpty = true } = {}) => {
      if (ended || aborted) return;
      ended = true;
      clearTimers();
      endPayload = { text: String(payload?.text || '') };
      if (reportEmpty && !endPayload.text.trim()) {
        onError?.({ code: 'no-speech', ...describeRecognitionError('no-speech') });
      }
      onEnd?.(endPayload);
      resolveStop?.(endPayload);
      resolveStop = null;
    };
    const stopWithoutEnd = (code) => {
      if (aborted || ended) return;
      const text = active?.text || '';
      active?.abort?.();
      if (text.trim()) {
        onNotice?.({ title: 'Браузер не завершил распознавание', description: 'Сохранены только подтверждённые слова; конец фразы мог потеряться.', tone: 'warn', ttl: 9000 });
      } else {
        onError?.({ code, title: 'Браузер не завершил распознавание', hint: 'Попробуйте записать фразу ещё раз.' });
      }
      settle({ text }, { reportEmpty: false });
    };
    const giveUp = (reason) => {
      if (ended || aborted) return;
      clearTimers();
      active?.abort?.();
      onError?.({
        code: 'web-unavailable',
        title: 'Распознавание недоступно',
        hint: isElectronShell()
          ? 'Офлайн-диктовке нужен движок распознавания, а его нет. Откройте «Настройки → Диктовка → Модель распознавания» и скачайте движок с моделью.'
          : 'Браузер не дал распознавание: системный движок выключен или нет сети. Полностью офлайн диктовка работает в приложении для Windows.',
      });
      if (reason) console.warn('[stt] Web Speech недоступен:', reason);
      settle({ text: '' }, { reportEmpty: false });
    };

    active = createWebRecognizer({
      lang,
      continuous,
      interimResults,
      onStart: () => {
        if (aborted || ended || userStopped) return;
        clearTimeout(watchdog);
        watchdog = null;
        onStart?.();
      },
      onPartial: (p) => {
        if (aborted || ended) return;
        emitted = true;
        onPartial?.(p);
      },
      onFinal: (p) => {
        if (aborted || ended) return;
        emitted = true;
        onFinal?.(p);
      },
      onEnd: (payload) => {
        if (aborted || ended) return;
        if (!emitted && !userStopped) {
          giveUp('браузер остановил распознавание и не перезапустился');
          return;
        }
        settle(payload);
      },
      onError: (err) => {
        if (aborted || ended) return;
        const unavailable = ['network', 'service-not-allowed', 'language-not-supported'].includes(err.code);
        if (unavailable && !emitted) {
          giveUp(err.code);
          return;
        }
        onError?.(err);
      },
    });

    return {
      kind: 'web-fallback',
      start() {
        // Назначаем до старта: onstart в некоторых реализациях может прийти сразу.
        watchdog = setTimeout(() => {
          if (!emitted && !ended && !aborted && !userStopped) giveUp('движок не поднялся за 2 с');
        }, 2000);
        try { active?.start?.(); } catch (err) { clearTimers(); throw err; }
      },
      stop() {
        if (stopPromise) return stopPromise;
        if (aborted) return Promise.resolve({ text: '', code: 'cancelled' });
        if (ended) return Promise.resolve(endPayload || { text: '' });
        userStopped = true;
        clearTimeout(watchdog);
        watchdog = null;
        stopPromise = new Promise((resolve) => { resolveStop = resolve; });
        // stop лишь просит браузер закончить. Финальное событие может прийти
        // после него; промежуточный текст нельзя сохранять как окончательный.
        stopTimer = setTimeout(() => stopWithoutEnd('web-stop-timeout'), 5000);
        if (active?.stop?.() === false) stopWithoutEnd('web-stop-failed');
        return stopPromise;
      },
      abort() {
        if (aborted || ended) return;
        aborted = true;
        clearTimers();
        active?.abort?.();
        resolveStop?.({ text: '', code: 'cancelled' });
        resolveStop = null;
      },
      get text() {
        return active?.text || '';
      },
    };
  }

  // 3) Совсем нечем распознавать
  {
    const dead = {
      kind: 'unavailable',
      start() {
        const err = {
          code: 'engine-missing',
          title: 'Распознавание недоступно',
          hint: isElectronShell()
            ? 'Настройки → Диктовка → Модель распознавания: скачайте движок и модель. Без них диктовка не работает.'
            : 'В этом браузере нет системного распознавания (нужен Chrome и интернет). Полностью офлайн диктовка работает в приложении для Windows.',
        };
        onError?.(err);
        setTimeout(() => onEnd?.({ text: '' }), 300);
        return err;
      },
      stop() {
        return { text: '' };
      },
      abort() {},
      get text() {
        return '';
      },
    };
    return dead;
  }
}

/** BCP-47 тег для Web Speech API. */
export function langTag(code) {
  const map = {
    ru: 'ru-RU',
    en: 'en-US',
    es: 'es-ES',
    de: 'de-DE',
    fr: 'fr-FR',
    zh: 'zh-CN',
    ja: 'ja-JP',
    tr: 'tr-TR',
    kk: 'kk-KZ',
    uk: 'uk-UA',
  };
  return map[code] || code || 'ru-RU';
}

export { describeRecognitionError };
