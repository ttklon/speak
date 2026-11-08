/**
 * ZSpeakly STT-движок с прозрачным фолбэком.
 *
 * Приоритет:
 *  1) whisper.cpp через main-процесс Electron (полностью офлайн, лучший вариант);
 *  2) Web Speech API (быстрый черновик);
 *  3) демо-движок — если браузер объявляет Web Speech, но сервис недоступен
 *     (типичный случай в офлайне и в headless-браузере), сессия автоматически
 *     переключается на демо-распознавание, чтобы интерфейс оставался живым.
 */

import { describeRecognitionError } from './errors.js';

const SpeechRecognitionImpl =
  typeof window !== 'undefined'
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null;

export const hasWebSpeech = Boolean(SpeechRecognitionImpl);
export const hasNativeStt = () =>
  typeof window !== 'undefined' && Boolean(window.zspeakly?.native?.transcribe);

export function engineName() {
  if (hasNativeStt()) return 'whisper.cpp (офлайн)';
  if (hasWebSpeech) return 'Web Speech (локально)';
  return 'демо-движок';
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

  // 1) Нативный whisper.cpp
  if (hasNativeStt()) {
    const native = window.zspeakly.native;
    let unsub = () => {};
    let timer = null;
    let text = '';
    return {
      kind: 'native',
      async start() {
        onStart?.();
        unsub = native.onEvent?.((msg) => {
          if (!msg) return;
          if (msg.type === 'level') onLevel?.(msg.value);
          if (msg.type === 'line') {
            text = [text, msg.text].filter(Boolean).join(' ');
            onFinal?.({ text: msg.text, last: msg.text });
          }
          if (msg.type === 'partial') onPartial?.({ text, interim: msg.text });
          if (msg.type === 'error') onError?.({ code: msg.code, title: msg.title, hint: msg.hint });
          if (msg.type === 'end') onEnd?.({ text: msg.text || text });
        });
        await native.startRecording?.({ lang });
        timer = setInterval(() => {
          const level = native.levelSync?.();
          if (typeof level === 'number') onLevel?.(level);
        }, 120);
      },
      async stop() {
        clearInterval(timer);
        const res = await native.stopRecording?.();
        unsub?.();
        if (res?.text) text = res.text;
        return { text };
      },
      abort() {
        clearInterval(timer);
        native.abortRecording?.();
        unsub?.();
      },
      get text() {
        return text;
      },
    };
  }

  // 2) Web Speech с автоматическим переходом на демо при недоступном сервисе
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

  // 3) Только демо
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
