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

const SpeechRecognitionImpl =
  typeof window !== 'undefined'
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null;

export const hasWebSpeech = Boolean(SpeechRecognitionImpl);
// В Electron моста достаточно, чтобы отличить настоящую сборку от превью.
const isElectronShell = () =>
  typeof window !== 'undefined' && Boolean(window.zspeakly?.isElectron);
// нужен именно PCM-канал: старый transcribe(wav) без записи звука бесполезен
export const hasNativeStt = () =>
  typeof window !== 'undefined' && Boolean(window.zspeakly?.native?.transcribePcm);

export function engineName() {
  if (hasNativeStt()) return 'whisper.cpp (офлайн)';
  if (hasWebSpeech && !isElectronShell()) return 'Web Speech (локально)';
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
  } = opts;

  // 1) Нативный whisper.cpp: пишем PCM в рендерере → main → whisper-cli.exe
  if (hasNativeStt()) {
    const native = window.zspeakly.native;
    let recorder = null;
    let text = '';
    let stopped = false;

    return {
      kind: 'native',
      async start() {
        try {
          recorder = await startPcmRecording({
            deviceId: opts.deviceId || 'default',
            onLevel: (v) => onLevel?.(v),
          });
          onStart?.();
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
        try {
          // pcm уходит как Int16Array: main превращает его в сырые байты сам,
          // иначе whisper получает мусор вместо звука (был именно такой баг)
          res = await native.transcribePcm?.({
            pcm,
            durationMs,
            lang: String(lang || 'ru').slice(0, 2),
            model: opts.model || 'small',
            // тумблер «Применять словарь при диктовке» управляет и подсказкой
            // whisper'у, и заменой слов в готовом тексте
            useDictionary: opts.useDictionary !== false,
            contextPrompt,
          });
        } catch (err) {
          onError?.({ code: 'stt-failed', title: 'Распознавание не удалось', hint: String(err?.message || err) });
          onEnd?.({ text: '' });
          return { text: '', reason: String(err?.message || err) };
        }
        if (res?.ok && res.text) {
          text = res.text;
          onFinal?.({ text: res.text, last: res.text });
          onEnd?.({ text: res.text });
        } else {
          onError?.({
            code: 'stt-empty',
            title: 'whisper.cpp не распознал',
            hint: res?.reason || 'Проверьте модель и микрофон в настройках',
          });
          onEnd?.({ text: '' });
        }
        return { text };
      },
      abort() {
        stopped = true;
        recorder?.abort?.();
        recorder = null;
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
          ? 'Web Speech не работает без интернета, а whisper.cpp не установлен. Откройте «Настройки → Функции → Модель распознавания» и скачайте движок с моделью.'
          : 'Браузер не дал распознавание: Web Speech выключен или нет сети. Полностью офлайн диктовка работает в приложении для Windows — там whisper.cpp.',
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
            ? 'Настройки → Функции → Модель распознавания: скачайте whisper.cpp и модель. Без них диктовка не работает.'
            : 'В этом браузере нет Web Speech (нужен Chrome и интернет). Полностью офлайн диктовка работает в приложении для Windows — там whisper.cpp.',
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
