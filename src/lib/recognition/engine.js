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

  rec.onstart = () => onStart?.();
  rec.onerror = (e) => onError?.({ code: e.error, ...describeRecognitionError(e.error) });
  rec.onend = () => {
    if (!stopped) {
      try {
        rec.start();
        return;
      } catch {
        /* ignore */
      }
    }
    onEnd?.({ text: finalText });
  };
  rec.onresult = (event) => {
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
      finalText = '';
      rec.start();
    },
    stop() {
      stopped = true;
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    },
    abort() {
      stopped = true;
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
        if (stopped || !recorder) return;
        // Отдаём чуть больше, чем «новый» звук: слово, разрезанное границей,
        // должно целиком попасть хотя бы в один кусок.
        const fromMs = Math.max(0, cut.fromMs - tracker.overlapMs);
        const snap = recorder.snapshot?.({ fromMs, toMs: cut.atMs, maxSeconds: 0 });
        if (!snap?.pcm?.length || snap.durationMs < 800) {
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
          if (res?.mode) lastMode = res.mode;
          if (res?.ok && String(res.text || '').trim()) {
            preText = mergeOverlap(preText, String(res.text).trim());
            preCount += 1;
            preMs += Number(res.ms) || 0;
          } else {
            // Пусто — значит кусок не распознан. Возвращаем границу, иначе
            // этот звук не попадёт ни в кусок, ни в хвост.
            tracker.rollback(cut.fromMs);
          }
        } catch {
          tracker.rollback(cut.fromMs);
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
            onLevel: (v) => {
              onLevel?.(v);
              // Уровень микрофона — единственный сигнал, по которому видно
              // паузу. Дальше решает чистый модуль chunks.js: он скажет,
              // можно ли уже отдать кусок движку.
              if (!shouldPreChunk(lastMode)) return;
              const atMs = recorder
                ? Math.round((recorder.frames / (recorder.sampleRate || 16000)) * 1000)
                : 0;
              const cut = tracker.feed({ level: v, atMs });
              if (cut) queuePreChunk(cut);
            },
            // предролл «горячего микрофона»: звук до нажатия хоткея
            preroll: opts.preroll || null,
          });
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
          // нет микрофона или отказали в доступе — сообщаем честно
          // Причина от браузера (NotAllowedError, NotFoundError) важнее
          // технического «Permission denied» — человеку нужен следующий шаг.
          const named = err?.name === 'NotAllowedError' ? 'not-allowed' : err?.name === 'NotFoundError' ? 'audio-capture' : '';
          const described = named ? describeRecognitionError(named) : describeRecognitionError('audio-capture');
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
        if (!recorder || stopped) return { text };
        stopped = true;
        // недоработанный промежуточный запрос больше не нужен: финальный
        // проход по всей записи всё равно точнее. Раньше он не отменялся и
        // работал параллельно с итоговым — два whisper-процесса, двойная
        // память и вдвое дольше ожидание.
        stopStream();
        // Досчитываем уже отправленный кусок: если оборвать его отменой, этот
        // звук пропадёт — он не попадёт ни в хвост, ни в результат.
        await Promise.race([preChain, new Promise((resolve) => setTimeout(resolve, 6000))]);
        try {
          await native.cancelTranscribe?.();
        } catch {
          /* отмена — не ошибка */
        }
        const { pcm, durationMs } = recorder.stop();
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
        const committedMs = Math.min(Number(tracker.committedMs) || 0, durationMs);
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
          res = await native.transcribePcm?.({
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
          });
        } catch (err) {
          onError?.({ code: 'stt-failed', title: 'Распознавание не удалось', hint: String(err?.message || err) });
          onEnd?.({ text: '' });
          return { text: '', reason: String(err?.message || err) };
        }
        if (res?.mode) lastMode = res.mode;
        if (res?.ok && res.text) {
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
          });
        } else if (preText) {
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

  // 2) Web Speech: настоящий браузерный движок. Если он не поднялся,
  // показываем ошибку, а не выдуманный текст.
  if (hasWebSpeech) {
    let active = null;
    let emitted = false;
    let ended = false;
    let userStopped = false;

    const emitEnd = (payload) => {
      if (ended) return;
      ended = true;
      onEnd?.(payload);
    };

    let switched = false;
    let watchdog = null;

    const giveUp = (reason) => {
      if (switched) return;
      switched = true;
      clearTimeout(watchdog);
      watchdog = null;
      try {
        active?.abort?.();
      } catch {
        /* ignore */
      }
      onError?.({
        code: 'web-unavailable',
        title: 'Распознавание недоступно',
        hint: isElectronShell()
          ? 'Офлайн-диктовке нужен движок распознавания, а его нет. Откройте «Настройки → Диктовка → Модель распознавания» и скачайте движок с моделью.'
          : 'Браузер не дал распознавание: системный движок выключен или нет сети. Полностью офлайн диктовка работает в приложении для Windows.',
      });
      if (reason) console.warn('[stt] Web Speech недоступен:', reason);
      emitEnd({ text: '' });
    };

    active = createWebRecognizer({
      lang,
      continuous,
      interimResults,
      onStart: () => {
        // Движок действительно запустился — сторож больше не нужен.
        clearTimeout(watchdog);
        watchdog = null;
        onStart?.();
      },
      onPartial: (p) => {
        emitted = true;
        onPartial?.(p);
      },
      onFinal: (p) => {
        emitted = true;
        onFinal?.(p);
      },
      // Если Web Speech завершился без результата и пользователь не останавливал
      // запись — ждём сторож: он честно скажет, что распознать не удалось.
      onEnd: (payload) => {
        if (!emitted && !userStopped) return;
        emitEnd(payload);
      },
      onError: (err) => {
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
        active?.start?.();
        // Если браузер объявил Web Speech, но движок не поднялся за 2 с
        // (нет сети / сервис отключён), честно говорим об этом.
        clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          if (!emitted) giveUp('движок не поднялся за 2 с');
        }, 2000);
      },
      stop() {
        userStopped = true;
        clearTimeout(watchdog);
        const res = active?.stop?.();
        const payload = res && typeof res.text === 'string' ? res : { text: active?.text || '' };
        // Web Speech может закончиться без текста и без ошибки (нет сети,
        // микрофон молчит). Раньше в этом случае не происходило вообще ничего:
        // человек говорил, нажимал «стоп» и не понимал, что случилось.
        if (!String(payload.text || '').trim()) {
          onError?.({ code: 'no-speech', ...describeRecognitionError('no-speech') });
        }
        return payload;
      },
      abort() {
        active?.abort?.();
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
