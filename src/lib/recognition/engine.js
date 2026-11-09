/**
 * ZSpeakly STT-движок с прозрачным фолбэком.
 *
 * Приоритет:
 *  1) whisper.cpp через main-процесс Electron (полностью офлайн, лучший вариант);
 *  2) Web Speech API (быстрый черновик);
 *  3) в браузерном превью — демо-движок, если Web Speech недоступен (офлайн,
 *     headless). В Electron демо НЕТ: там отсутствие движка — это честная
 *     ошибка с подсказкой, а не выдуманный текст в чужом окне.
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
  return 'демо-движок (превью)';
}

const DEMO_LINES = {
  ru: [
    'Привет, как дела?',
    'Записываю голосом, и текст сам появляется в активном поле',
    'ZSpeakly работает офлайн: без облака и без лимитов',
  ],
  en: [
    'Hey, how are you?',
    'I am dictating with my voice and the text appears instantly',
    'ZSpeakly works offline, without cloud and without limits',
  ],
  kk: ['Сәлеметсіз бе, қалайсыз?', 'Дауыспен жазып отырмын, мәтін өзі шығады'],
};

/** Демо-движок: «печатает» заготовленные фразы, чтобы UI был проверяем без микрофона. */
function createDemoRecognizer({ lang = 'ru', onPartial, onFinal, onError, onEnd, onStart, onLevel }) {
  let stopped = true;
  let text = '';
  let timer = null;
  let levelTimer = null;

  const pool = DEMO_LINES[String(lang).slice(0, 2)] || DEMO_LINES.ru;

  return {
    kind: 'demo',
    start() {
      stopped = false;
      text = '';
      onStart?.();
      let index = 0;
      let charIndex = 0;
      let pauseUntil = 0;

      timer = setInterval(() => {
        if (stopped) return;
        if (Date.now() < pauseUntil) return;
        const current = pool[index];
        if (!current) return;
        charIndex = Math.min(current.length, charIndex + 2);
        onPartial?.({ text, interim: current.slice(0, charIndex) });
        if (charIndex >= current.length) {
          text = [text, current].filter(Boolean).join(' ');
          onFinal?.({ text: current, last: current });
          index += 1;
          charIndex = 0;
          pauseUntil = Date.now() + 520;
          if (index >= pool.length) {
            clearInterval(timer);
            timer = null;
            setTimeout(() => {
              if (!stopped) onEnd?.({ text });
            }, 520);
          }
        }
      }, 55);

      levelTimer = setInterval(() => {
        if (!stopped) onLevel?.(0.3 + Math.random() * 0.65);
      }, 110);
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      clearInterval(levelTimer);
      if (!text) onError?.({ code: 'no-speech', ...describeRecognitionError('no-speech') });
      onEnd?.({ text });
      return { text };
    },
    abort() {
      stopped = true;
      clearInterval(timer);
      clearInterval(levelTimer);
    },
    get text() {
      return text;
    },
  };
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
          onError?.({ code: 'too-short', title: 'Слишком короткая запись', hint: 'Удерживайте клавишу чуть дольше и говорите сразу.' });
          onEnd?.({ text: '' });
          return { text: '', reason: 'too-short' };
        }
        let res;
        try {
          // pcm уходит как Int16Array: main превращает его в сырые байты сам,
          // иначе whisper получает мусор вместо звука (был именно такой баг)
          res = await native.transcribePcm?.({
            pcm,
            durationMs,
            lang: String(lang || 'ru').slice(0, 2),
            model: opts.model || 'small',
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

  // 2) Web Speech. Демо-движок подключаем ТОЛЬКО в браузерном превью:
  // в Electron он вставлял выдуманный текст в чужое окно — это была заглушка,
  // из-за которой «диктовка работает», хотя распознавания не происходило.
  if (hasWebSpeech) {
    let active = null;
    let emitted = false;
    let demo = null;
    let ended = false;
    let userStopped = false;

    const emitEnd = (payload) => {
      if (ended) return;
      ended = true;
      onEnd?.(payload);
    };

    let switched = false;

    const switchToDemo = (reason) => {
      if (switched) return;
      switched = true;
      clearTimeout(watchdog);
      watchdog = null;
      try {
        active?.abort?.();
      } catch {
        /* ignore */
      }
      if (isElectronShell()) {
        // нечего слушать: без сети Web Speech бесполезен, а whisper.cpp не найден
        onError?.({
          code: 'web-unavailable',
          title: 'Распознавание недоступно',
          hint: 'Web Speech не работает без интернета, а whisper.cpp не установлен. Откройте «Настройки → Функции → Модель распознавания» и скачайте движок с моделью.',
        });
        emitEnd({ text: '' });
        return;
      }
      demo = createDemoRecognizer({
        lang: lang.slice(0, 2),
        onStart,
        onPartial: (p) => {
          emitted = true;
          onPartial?.(p);
        },
        onFinal: (p) => {
          emitted = true;
          onFinal?.(p);
        },
        onError,
        onEnd: emitEnd,
        onLevel,
      });
      active = demo;
      demo.start();
      if (reason) {
        onError?.({
          code: 'fallback',
          title: 'Работает демо-движок',
          hint: 'Web Speech недоступен без сети. Подключите whisper.cpp для офлайн-распознавания.',
        });
      }
    };

    let watchdog = null;
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
      // запись — ждём сторож, который переключит на демо-движок.
      onEnd: (payload) => {
        if (!emitted && !userStopped) return;
        emitEnd(payload);
      },
      onError: (err) => {
        const unavailable = ['network', 'service-not-allowed', 'language-not-supported'].includes(err.code);
        if (unavailable && !emitted) {
          switchToDemo(true);
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
        // (нет сети / сервис отключён), переключаемся на демо-движок.
        clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          if (!emitted) switchToDemo(true);
        }, 2000);
      },
      stop() {
        userStopped = true;
        clearTimeout(watchdog);
        const res = active?.stop?.();
        return res && typeof res.text === 'string' ? res : { text: active?.text || '' };
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
  if (isElectronShell()) {
    const dead = {
      kind: 'unavailable',
      start() {
        const err = {
          code: 'engine-missing',
          title: 'Движок распознавания не установлен',
          hint: 'Настройки → Функции → Модель распознавания: скачайте whisper.cpp и модель. Без них диктовка не работает.',
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

  // 4) Демо — только браузерное превью, где это осознанная демонстрация
  return createDemoRecognizer({ lang: lang.slice(0, 2), onPartial, onFinal, onError, onEnd, onStart, onLevel });
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
