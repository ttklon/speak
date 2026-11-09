/**
 * Диктовка: глобальный хоткей (удержание), поток Web Speech / whisper.cpp,
 * уровень микрофона, история, статистика, «вставка» в активное поле.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createRecognizer, engineName, hasNativeStt, hasWebSpeech, langTag } from '../lib/recognition/engine.js';
import { applyDictionary, formatK, postProcess, words } from '../lib/utils.js';
import { useAppData } from './AppDataProvider.jsx';
import { OPS } from '../lib/ai/textops.js';
import { playCue } from '../lib/feedback.js';
import { diag } from '../lib/diagnostics.js';
import { useToast } from './ToastProvider.jsx';

/** Предпросмотр диктовки: читаем результат системным голосом Windows. */
function speak(text, language = 'ru', voiceURI = '') {
  if (!text || typeof speechSynthesis === 'undefined') return;
  try {
    speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    const map = {
      ru: 'ru-RU', en: 'en-US', de: 'de-DE', es: 'es-ES', fr: 'fr-FR',
      zh: 'zh-CN', ja: 'ja-JP', tr: 'tr-TR', kk: 'kk-KZ', uk: 'uk-UA',
    };
    utter.lang = map[language] || language;
    utter.rate = 1.02;
    if (voiceURI) {
      const match = speechSynthesis.getVoices?.().find((v) => v.voiceURI === voiceURI);
      if (match) {
        utter.voice = match;
        utter.lang = match.lang || utter.lang;
      }
    }
    speechSynthesis.speak(utter);
  } catch {
    /* голоса нет — молча пропускаем */
  }
}

const DictationContext = createContext(null);

export function DictationProvider({ children }) {
  const { settings, dictionary, addDictation, recordWords } = useAppData();
  const [state, setState] = useState('idle'); // idle | listening | processing | done
  const [draft, setDraft] = useState(''); // живой текст
  const [level, setLevel] = useState(0);
  const [error, setError] = useState(null);
  const [last, setLast] = useState(null); // {text, createdAt, words, durationMs}
  const [mode, setMode] = useState('hold');
  const [elapsed, setElapsed] = useState(0);
  const [hudOpen, setHudOpen] = useState(false);

  const recRef = useRef(null);
  const startedAt = useRef(0);
  const draftRef = useRef('');
  const finalRef = useRef('');
  const settingsRef = useRef(settings);
  const dictRef = useRef(dictionary);
  const stopFallback = useRef(null);
  const finishing = useRef(false);

  useEffect(() => {
    settingsRef.current = settings;
    dictRef.current = dictionary;
  }, [settings, dictionary]);

  const engine = useMemo(() => engineName(), []);
  const { push: pushToast } = useToast();

  // ошибка не должна висеть на экране навсегда: 12 секунд — и убираем
  useEffect(() => {
    if (!error) return undefined;
    const t = setTimeout(() => setError(null), 12000);
    return () => clearTimeout(t);
  }, [error]);

  // Обработка «затянулась»: плашка не должна показывать 0.0 с и «Транскрибирую…»
  // без движения — сообщаем, сколько уже ждём.
  useEffect(() => {
    if (state !== 'processing') return undefined;
    const t = setInterval(() => setElapsed(Date.now() - startedAt.current), 500);
    return () => clearInterval(t);
  }, [state]);

  const finish = useCallback(
    (text) => {
      // защита от двойного завершения (web-движок + фолбэк)
      if (finishing.current) return null;
      finishing.current = true;
      setTimeout(() => {
        finishing.current = false;
      }, 700);
      const raw = text || finalRef.current || draftRef.current;
      const cleaned = OPS.clean(postProcess(applyDictionary(raw, dictRef.current), {}));
      const durationMs = Math.max(400, Date.now() - startedAt.current);
      const item = {
        text: cleaned,
        durationMs,
        words: words(cleaned),
        createdAt: Date.now(),
        // id нужен, чтобы «эффект печати» точно понял, что пришёл новый текст
        id: `d-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        language: settingsRef.current.language,
        source: 'dictation',
      };
      // событие в журнал: видно, что движок реально вернул текст, а не «тишину»
      diag.info('stt', cleaned ? 'Диктовка распознана' : 'Пустой результат распознавания', {
        chars: cleaned.length,
        words: item.words,
        durationMs,
        engine: engineName(),
      });
      setState(cleaned ? 'done' : 'idle');
      setDraft('');
      draftRef.current = '';
      finalRef.current = '';
      if (cleaned) {
        setLast(item);
        addDictation(item);
        recordWords(item.words, durationMs);
        if (settingsRef.current.readAloud) {
          speak(cleaned, settingsRef.current.language, settingsRef.current.readAloudVoice || '');
        }
        // нативное уведомление Windows: «готово, вставлено» — по настройке
        if (settingsRef.current.notifications && window.zspeakly?.native?.notify) {
          window.zspeakly.native
            .notify({ title: 'Готово', body: cleaned.slice(0, 120), silent: true })
            .catch(() => {});
        }
      }
      setTimeout(() => setState((s) => (s === 'done' ? 'idle' : s)), 2200);
      return item;
    },
    [addDictation, recordWords],
  );

  const start = useCallback(
    (opts = {}) => {
      if (recRef.current) return;
      setError(null);
      setDraft('');
      draftRef.current = '';
      finalRef.current = '';
      startedAt.current = Date.now();
      setElapsed(0);
      setState('listening');
      if (opts.mode) setMode(opts.mode);
      setHudOpen(true);
      // настройка «Звуковой отклик» — короткий сигнал на старте
      if (settingsRef.current.soundFeedback !== false) playCue('start');

      // На свежей установке движок или модель могут быть не скачаны.
      // Предупреждаем сразу — иначе человек наговорит минуту и получит пустоту.
      if (hasNativeStt() && window.zspeakly?.native?.sttStatus) {
        window.zspeakly.native
          .sttStatus(settingsRef.current.whisperModel)
          .then((st) => {
            if (st && st.available === false) {
              setError({
                code: 'engine-missing',
                title: 'Движок распознавания не установлен',
                hint: `${
                  !st.bin ? 'Нет whisper.cpp' : 'Нет модели'
                } — скачайте в «Настройки → Функции → Модель распознавания».`,
              });
            }
          })
          .catch(() => {});
      }

      const recognizer = createRecognizer({
        lang: langTag(settingsRef.current.language),
        deviceId: settingsRef.current.audioDeviceId,
        model: settingsRef.current.whisperModel,
        onStart: () => setState('listening'),
        onPartial: ({ text, interim }) => {
          const composed = [text, interim].filter(Boolean).join(' ');
          draftRef.current = composed;
          setDraft(composed);
        },
        onFinal: ({ text }) => {
          finalRef.current = text;
          draftRef.current = text;
          setDraft(text);
        },
        onLevel: (v) => setLevel(v),
        onError: (err) => {
          // каждая ошибка движка должна быть видна в диагностике, иначе
          // «не работает» невозможно разобрать постфактум
          diag.warn('stt', err?.title || err?.code || 'Ошибка распознавания', {
            code: err?.code,
            hint: err?.hint,
          });
          setError(err);
          // и в тосте: плашка могла быть скрыта или уже закрыться
          if (err?.title && !/fallback|демо/i.test(err.title)) {
            pushToast({
              title: err.title,
              description: err.hint || '',
              tone: 'warn',
              ttl: 9000,
            });
          }
          // Движка нет / он недоступен — запись продолжать бессмысленно:
          // иначе человек говорит в пустоту и ждёт результата.
          const fatal = ['not-allowed', 'service-not-allowed', 'network', 'web-unavailable', 'engine-missing'];
          if (fatal.includes(err.code)) {
            const rec = recRef.current;
            recRef.current = null;
            try {
              rec?.abort?.();
            } catch {
              /* ignore */
            }
            setState('idle');
            setLevel(0);
          }
        },
        onEnd: ({ text }) => {
          recRef.current = null;
          setState('processing');
          setLevel(0);
          // небольшая задержка — «транскрипция» как в видео
          setTimeout(() => {
            const item = finish(text);
            if (opts.onResult) opts.onResult(item);
            if (opts.insert !== false && item?.text && window.zspeakly?.native?.insertText) {
              window.zspeakly.native.insertText(item.text);
            }
          }, 260);
        },
      });
      recRef.current = recognizer;
      // start() у нативного движка асинхронный (нужно разрешение на микрофон)
      const failStart = (err) => {
        console.warn('[dictation] start failed', err);
        diag.error('stt', 'Не удалось начать запись', { reason: String(err?.message || err) });
        recRef.current = null;
        setState('idle');
        setLevel(0);
      };
      try {
        const started = recognizer.start();
        if (started && typeof started.then === 'function') started.catch(failStart);
      } catch (err) {
        failStart(err);
      }
    },
    [finish],
  );

  const stop = useCallback(async () => {
    const rec = recRef.current;
    setState('processing');
    setLevel(0);
    if (rec && settingsRef.current.soundFeedback !== false) playCue('stop');
    if (!rec) return;
    const fallbackText = rec.text || draftRef.current;
    recRef.current = null;
    clearTimeout(stopFallback.current);

    // Нативный whisper.cpp останавливается АСИНХРОННО: сначала закрывается
    // микрофон, потом main-процесс гоняет whisper-cli. Раньше результат-
    // промис игнорировался, состояние «обрабатываю…» висело вечно и ничего
    // не транскрибировалось — ровно та жалоба, что пришла от пользователя.
    let result;
    try {
      result = rec.stop?.();
      if (result && typeof result.then === 'function') result = await result;
    } catch (err) {
      console.warn('[dictation] stop failed', err);
      diag.error('stt', 'Не удалось завершить запись', { reason: String(err?.message || err) });
      setError({ code: 'stop-failed', title: 'Не удалось завершить запись', hint: String(err) });
      setState('idle');
      return;
    }

    const text = (result && result.text) || fallbackText || '';
    const item = finish(text);
    if (!item && text.trim()) return;
    if (!text.trim()) setState('idle');
  }, [finish]);

  const toggle = useCallback(() => {
    if (recRef.current) stop();
    else start({ mode: 'toggle' });
  }, [start, stop]);

  // Страховка: если движок замолчал и не прислал ни конца, ни ошибки,
  // «обрабатываю…» не должно висеть бесконечно — через 90 секунд сдаёмся
  // и честно показываем ошибку вместо вечной плашки.
  useEffect(() => {
    if (state !== 'processing') return undefined;
    const t = setTimeout(() => {
      setError((prev) =>
        prev || {
          code: 'stt-timeout',
          title: 'Распознавание не ответило',
          hint: 'Проверьте модель в «Настройки → Функции» и отправьте логи из «Настройки → Диагностика».',
        },
      );
      setState('idle');
    }, 90000);
    return () => clearTimeout(t);
  }, [state]);

  // Таймер длительности
  useEffect(() => {
    if (state !== 'listening') return undefined;
    const t = setInterval(() => setElapsed(Date.now() - startedAt.current), 100);
    return () => clearInterval(t);
  }, [state]);

  // Глобальный хоткей из Electron (удержание клавиши)
  useEffect(() => {
    const bridge = window.zspeakly?.native;
    if (!bridge?.onHotkey) return undefined;
    const off = bridge.onHotkey((payload) => {
      if (payload?.type === 'down') start({ mode: 'hold' });
      if (payload?.type === 'up') stop();
      if (payload?.type === 'toggle') toggle();
    });
    return off;
  }, [start, stop, toggle]);

  // Локальный хоткей браузера: Alt+D — старт/стоп (для dev-preview)
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.altKey && (e.code === 'KeyD' || e.key?.toLowerCase() === 'd')) {
        e.preventDefault();
        if (recRef.current) stop();
        else start({ mode: 'hold' });
      }
      if (e.key === 'Escape' && recRef.current) {
        recRef.current?.abort?.();
        recRef.current = null;
        setState('idle');
        setDraft('');
        setLevel(0);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [start, stop]);

  // Держим HUD открытым, пока идёт запись
  useEffect(() => {
    if (state === 'listening') setHudOpen(true);
  }, [state]);

  const value = useMemo(
    () => ({
      state,
      draft,
      level,
      error,
      last,
      mode,
      elapsed,
      hudOpen,
      engine,
      hasWebSpeech,
      start,
      stop,
      toggle,
      finish,
      clearError: () => setError(null),
      setHudOpen,
      formatK,
    }),
    [state, draft, level, error, last, mode, elapsed, hudOpen, engine, start, stop, toggle, finish],
  );

  return <DictationContext.Provider value={value}>{children}</DictationContext.Provider>;
}

export function useDictation() {
  const ctx = useContext(DictationContext);
  if (!ctx) throw new Error('useDictation must be used inside DictationProvider');
  return ctx;
}

export default DictationProvider;
