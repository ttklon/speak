/**
 * Диктовка: глобальный хоткей (удержание), поток Web Speech / whisper.cpp,
 * уровень микрофона, история, статистика, «вставка» в активное поле.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createRecognizer, engineName, hasNativeStt, hasWebSpeech, langTag } from '../lib/recognition/engine.js';
import { createMicWarm } from '../lib/audio/micWarm.js';
import { applyDictionary, formatK, postProcess, words } from '../lib/utils.js';
import { useAppData } from './AppDataProvider.jsx';
import { OPS, llmRewrite, polishDictation } from '../lib/ai/textops.js';
import { describeScreen } from '../lib/ai/vision.js';
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
  // живая расшифровка возможна только с whisper.cpp: браузерный движок сам
  // отдаёт промежуточный текст, а whisper нужно спрашивать повторно
  const liveText = settings.liveWhisper !== false && hasNativeStt();
  // отдельное окно индикатора реально показано (а не просто «должно быть»)
  const [hudNativeOn, setHudNativeOn] = useState(false);
  const hudHiddenByUser = useRef(false);

  const recRef = useRef(null);
  const startedAt = useRef(0);
  const draftRef = useRef('');
  const finalRef = useRef('');
  const settingsRef = useRef(settings);
  const dictRef = useRef(dictionary);
  const stopFallback = useRef(null);
  const finishing = useRef(false);
  // опции текущей диктовки (нужны при остановке: вставлять текст или нет)
  const sessionOpts = useRef({});
  // кадр экрана для «диктовки с учётом экрана» (в памяти, не на диске)
  const screenContextRef = useRef(null);
  // термины, которые локальная модель разглядела на экране: уходят в whisper
  // как подсказка. Живут до следующего кадра и нигде не сохраняются.
  const screenTermsRef = useRef('');

  useEffect(() => {
    settingsRef.current = settings;
    dictRef.current = dictionary;
  }, [settings, dictionary]);

  const engine = useMemo(() => engineName(), []);
  const { push: pushToast } = useToast();
  // когда последний раз предупреждали, что модель не улучшила диктовку
  const rewriteWarnedAt = useRef(0);
  // «горячий микрофон»: поток открыт заранее, последние 600 мс лежат в буфере
  const micWarm = useRef(null);
  // достаточный ли статус, чтобы интерфейс не врал про открытый микрофон
  const [micWarmState, setMicWarmState] = useState('off'); // off | opening | open | failed

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
    async (text, { insert = true, sttMs = 0 } = {}) => {
      // защита от двойного завершения (web-движок + фолбэк); держим до конца
      // второй стадии, иначе модель успевала запуститься дважды
      if (finishing.current) return null;
      finishing.current = true;
      // страховка: если вторая стадия почему-то не вернётся, диктовка не должна
      // навсегда остаться «занятой»
      const hardReset = setTimeout(() => {
        finishing.current = false;
      }, 9000);
      // после завершения держим флаг ещё 700 мс: движок и кнопка «стоп»
      // присылают результат почти одновременно, и без паузы диктовка
      // записывалась дважды
      const release = () => {
        clearTimeout(hardReset);
        setTimeout(() => {
          finishing.current = false;
        }, 700);
      };
      const raw = text || finalRef.current || draftRef.current;
      // настройка «Применять словарь при диктовке»: раньше тумблер в разделе
      // «Словарь» только сохранялся, а замены делались всегда
      const applyDict = settingsRef.current.dictionaryEnabled !== false;
      const corrected = applyDict ? applyDictionary(raw, dictRef.current) : raw;
      // Тумблер «Постобработка текста» в настройках раньше только сохранялся:
      // чистка шла всегда. Теперь выключенный тумблер оставляет текст как есть,
      // а включённый убирает паразитов и расставляет пунктуацию.
      const polishing = settingsRef.current.aiProcessing !== false;
      let cleaned = polishing ? OPS.clean(postProcess(corrected, {})) : corrected.trim();
      // Вторая стадия («Переписывать диктовку моделью»): офлайн-правила уже
      // дали текст, локальная модель доводит формулировки. Модель может
      // не ответить — тогда остаётся результат правил, диктовка не ломается.
      if (polishing && cleaned && settingsRef.current.aiDictationRewrite === true) {
        setState('processing');
        const before = cleaned.length;
        const better = await polishDictation(cleaned, settingsRef.current, { timeout: 6000 });
        if (better) {
          cleaned = OPS.clean(better);
          diag.info('stt', 'Диктовку довела локальная модель', {
            before,
            after: cleaned.length,
            model: settingsRef.current.aiModel || '',
          });
        } else {
          // Галочка включена, а модель ничего не дала. Молчать нельзя: человек
          // думает, что текст «улучшается», хотя работает офлайн-правила.
          diag.warn('stt', 'Модель не улучшила диктовку — оставлены правила', {
            reason: settingsRef.current.aiEndpoint ? 'empty-or-unsane' : 'no-endpoint',
          });
          // не чаще раза в 5 минут, чтобы не засыпать тостами на каждой фразе
          if (Date.now() - rewriteWarnedAt.current > 5 * 60 * 1000) {
            rewriteWarnedAt.current = Date.now();
            if (!settingsRef.current.aiEndpoint) {
              pushToast({
                title: 'Модель не настроена',
                description: 'Галочка «Переписывать диктовку моделью» включена, но адрес Ollama пуст — текст чистят офлайн-правила.',
                tone: 'warn',
                ttl: 9000,
              });
            } else {
              pushToast({
                title: 'Модель не ответила',
                description: 'Диктовка очищена офлайн-правилами. Проверьте, запущена ли Ollama: «Настройки → Сеть → Проверить соединение».',
                tone: 'warn',
                ttl: 9000,
              });
            }
          }
        }
      }
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
        // сколько заняло распознавание (только для whisper.cpp) — видно в диагностике
        sttMs: sttMs || undefined,
      };
      // событие в журнал: видно, что движок реально вернул текст, а не «тишину»
      diag.info('stt', cleaned ? 'Диктовка распознана' : 'Пустой результат распознавания', {
        chars: cleaned.length,
        words: item.words,
        durationMs,
        sttMs: sttMs || 0,
        engine: engineName(),
      });
      setState(cleaned ? 'done' : 'idle');
      setDraft('');
      draftRef.current = '';
      finalRef.current = '';
      if (!cleaned) {
        release();
        return item;
      }
      if (cleaned) {
        setLast(item);
        addDictation(item);
        recordWords(item.words, durationMs);
        // Вставка в активное окно. Раньше она жила только в onEnd движка,
        // и при остановке через кнопку или отпускание хоткея текст молча
        // оставался в истории — в приложении он не появлялся.
        const native = window.zspeakly?.native;
        if (insert && sessionOpts.current.insert !== false && native?.insertText) {
          // main отвечает false, если SendKeys не сработал (окно с правами
          // администратора, игра, защищённое поле). Текст уже в буфере —
          // говорим об этом, иначе диктовка выглядит «сломанной».
          Promise.resolve(native.insertText(cleaned))
            .then((ok) => {
              if (ok === false) {
                pushToast({
                  title: 'Текст скопирован в буфер',
                  description: 'Вставить автоматически не удалось — нажмите Ctrl+V в нужном окне.',
                  tone: 'warn',
                  ttl: 9000,
                });
              }
            })
            .catch(() => {});
        }
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
      release();
      return item;
    },
    [addDictation, recordWords],
  );

  useEffect(() => {
    const wanted = settingsRef.current?.micPreroll === true && hasNativeStt();
    const current = micWarm.current;
    if (!wanted) {
      current?.close?.();
      micWarm.current = null;
      setMicWarmState('off');
      return undefined;
    }
    const warm = createMicWarm({
      prerollMs: 600,
      deviceId: settingsRef.current?.audioDeviceId || 'default',
    });
    micWarm.current = warm;
    setMicWarmState('opening');
    warm
      .open()
      .then(() => setMicWarmState('open'))
      .catch((err) => {
        diag.warn('mic', 'Горячий микрофон не открылся', { reason: String(err?.message || err) });
        setMicWarmState('failed');
        if (micWarm.current === warm) micWarm.current = null;
      });
    return () => {
      warm.close();
      if (micWarm.current === warm) micWarm.current = null;
      setMicWarmState('off');
    };
  }, [settings.micPreroll, settings.audioDeviceId]);

  const start = useCallback(
    (opts = {}) => {
      if (recRef.current) return;
      sessionOpts.current = opts;
      // новая диктовка — снова показываем плавающее окно, даже если прошлое скрыли
      hudHiddenByUser.current = false;
      setError(null);
      setDraft('');
      draftRef.current = '';
      finalRef.current = '';
      startedAt.current = Date.now();
      setElapsed(0);
      setState('listening');
      if (opts.mode) setMode(opts.mode);
      setHudOpen(true);
      // «диктовка с учётом экрана»: один снимок экрана, чтобы подсказать
      // распознаванию контекст (термины, имена). Снимок не сохраняется на диск.
      if (opts.screenAware && window.zspeakly?.native?.captureScreen) {
        // кадр нужен только локальной модели с поддержкой изображений: она
        // называет термины с экрана, а они становятся подсказкой для whisper.
        // Текст диктовки в запрос не попадает — модели показывают экран.
        window.zspeakly.native
          .captureScreen()
          .then(async (shot) => {
            if (!shot?.ok) return;
            screenContextRef.current = shot.image;
            const { aiEndpoint, aiModel, aiProcessing } = settingsRef.current || {};
            if (!aiEndpoint || aiProcessing === false) {
              diag.info('stt', 'Контекст экрана снят, но модель не настроена', {
                keep: true,
                width: shot.width,
                height: shot.height,
                used: false,
              });
              return;
            }
            const ctx = await describeScreen(shot.image, { endpoint: aiEndpoint, model: aiModel });
            if (ctx.ok) {
              screenTermsRef.current = ctx.terms;
              diag.info('stt', 'Контекст экрана распознан', {
                keep: true,
                terms: ctx.terms.split(',').length,
                chars: ctx.terms.length,
              });
            } else {
              // не ошибка диктовки: просто распознаём без подсказки с экрана
              diag.warn('stt', 'Контекст экрана не получен', { reason: ctx.reason });
            }
          })
          .catch(() => {});
      }
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

      // предролл забираем один раз: иначе звук прошлой диктовки попадёт в новую
      const preroll = micWarm.current?.take?.() || null;
      const recognizer = createRecognizer({
        lang: langTag(settingsRef.current.language),
        deviceId: settingsRef.current.audioDeviceId,
        preroll,
        model: settingsRef.current.whisperModel,
        // словарь идёт в whisper как подсказка только если тумблер включён
        useDictionary: settingsRef.current.dictionaryEnabled !== false,
        // контекст экрана читаем в момент остановки, а не старта: модель могла
        // ещё не ответить, когда человек уже отпустил клавишу
        getContextPrompt: () => (opts.screenAware ? screenTermsRef.current : ''),
        // 2,5 с — компромисс: whisper на коротком отрезке успевает за это время,
        // а текст в плашке не отстаёт от речи на полминуты
        streamIntervalMs: settingsRef.current.liveWhisper !== false ? 2500 : 0,
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
        // не ошибка, но человек должен знать: микрофон из настроек пропал
        onNotice: (t) => pushToast(t),
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
        onEnd: async ({ text, ms }) => {
          recRef.current = null;
          setState('processing');
          setLevel(0);
          // Текст вставляем сразу: искусственная пауза «как в видео» только
          // задерживала вставку (диктовка должна появляться в окне мгновенно).
          // Исключение — включённая вторая стадия чистки моделью: тогда ждём её.
          const item = await finish(text, { sttMs: ms });
          if (opts.onResult) opts.onResult(item);
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
    // записи нет — нечего останавливать: иначе плашка «Транскрибирую…» висела
    // до 90-секундного сторожа
    if (!rec) {
      setState('idle');
      return;
    }
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
    const item = await finish(text);
    if (!item && text.trim()) return;
    if (!text.trim()) setState('idle');
  }, [finish]);

  /**
   * «Режим агента»: двойное нажатие сочетания — задаём короткий вопрос
   * локальной модели (Ollama) по выделенному тексту или последней диктовке.
   * Полностью офлайн; если модель недоступна — честный тост, а не тишина.
   */
  const askAgent = useCallback(async () => {
    const question = String(finalRef.current || draftRef.current || '').trim();
    const base = question || 'Кратко перескажи этот текст и назови главное действие.';
    const settingsNow = settingsRef.current || {};
    if (!settingsNow.aiEndpoint) {
      pushToast({
        title: 'Агент не настроен',
        description: 'Укажите адрес локальной модели в «Настройки → Сеть».',
        tone: 'warn',
        ttl: 9000,
      });
      return;
    }
    setState('processing');
    diag.info('agent', 'Запрос к локальной модели', { chars: base.length });
    try {
      const source = await (window.zspeakly?.native?.readSelection?.() || Promise.resolve(''));
      const prompt = source && String(source).trim()
        ? `Контекст:\n${String(source).slice(0, 4000)}\n\nВопрос: ${base}`
        : base;
      const answer = await llmRewrite({
        endpoint: settingsNow.aiEndpoint,
        model: settingsNow.aiModel,
        system: 'Ответь коротко и по делу, без вступлений.',
        text: prompt,
        timeout: 20000,
      });
      if (!answer) {
        diag.warn('agent', 'Локальная модель не ответила');
        pushToast({
          title: 'Модель не ответила',
          description: 'Проверьте, запущен ли Ollama: «Настройки → Сеть → Проверить соединение».',
          tone: 'warn',
          ttl: 9000,
        });
        setState('idle');
        return;
      }
      const item = await finish(answer, { insert: false });
      if (item) pushToast({ title: 'Ответ агента готов', description: answer.slice(0, 120), tone: 'success' });
    } catch (err) {
      diag.error('agent', 'Ошибка агента', { reason: String(err?.message || err) });
      pushToast({ title: 'Агент не сработал', description: String(err?.message || err), tone: 'warn' });
      setState('idle');
    }
  }, [finish, pushToast]);

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

  /** Отменить начатую запись без распознавания и без истории. */
  const cancel = useCallback(() => {
    try {
      recRef.current?.abort?.();
    } catch {
      /* движок мог уже закрыться */
    }
    recRef.current = null;
    finalRef.current = '';
    draftRef.current = '';
    setDraft('');
    setLevel(0);
    setElapsed(0);
    setState('idle');
  }, []);

  // Глобальный хоткей из Electron (удержание клавиши)
  useEffect(() => {
    const bridge = window.zspeakly?.native;
    if (!bridge?.onHotkey) return undefined;
    const off = bridge.onHotkey((payload) => {
      if (payload?.type === 'down') {
        // «с учётом экрана»: снимаем контекст один раз на старте записи
        start({ mode: payload.mode === 'toggle' ? 'toggle' : 'hold', screenAware: payload.screenAware });
      }
      if (payload?.type === 'up') stop();
      if (payload?.type === 'toggle') {
        // «диктовка с учётом экрана» на своём сочетании тоже переключатель
        if (payload.screenAware && !recRef.current) start({ mode: 'toggle', screenAware: true });
        else toggle();
      }
      // «Агент» по двойному нажатию: начатая диктовка отменяется, а не
      // распознаётся — из неё всё равно вышел бы обрывок в полслова
      if (payload?.type === 'cancel') cancel();
      if (payload?.type === 'agent') askAgent();
    });
    return off;
  }, [start, stop, toggle, cancel, askAgent]);

  // Локальный хоткей браузера: Alt+D — старт/стоп (для dev-preview)
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.altKey && (e.code === 'KeyD' || e.key?.toLowerCase() === 'd')) {
        e.preventDefault();
        if (recRef.current) stop();
        else start({ mode: 'hold' });
      }
      if (e.key === 'Escape' && recRef.current) cancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [start, stop]);

  // Держим HUD открытым, пока идёт запись
  useEffect(() => {
    if (state === 'listening') setHudOpen(true);
  }, [state]);

  // ── Плавающий индикатор в отдельном окне (только Electron) ────────────────
  // Внутри главного окна индикатор виден лишь когда окно на экране: свернул
  // приложение — и запись «потерялась». Отдельное окно поверх всех приложений
  // показывает уровень, время и кнопки «стоп»/«скрыть».
  const nativeHud = typeof window !== 'undefined' ? Boolean(window.zspeakly?.native?.hudShow) : false;
  const hudAllowed = nativeHud && settings.showFloatingIndicator !== false;
  const lastHudSent = useRef(0);

  useEffect(() => {
    if (!hudAllowed) {
      // настройку выключили прямо во время записи — плашку надо убрать,
      // иначе она останется на экране до конца диктовки
      window.zspeakly?.native?.hudHide?.();
      setHudNativeOn(false);
      return undefined;
    }
    const native = window.zspeakly?.native;
    if ((state === 'listening' || state === 'processing') && !hudHiddenByUser.current) {
      Promise.resolve(native?.hudShow?.())
        .then((ok) => setHudNativeOn(Boolean(ok)))
        .catch(() => setHudNativeOn(false));
      return undefined;
    }
    // Ошибку показываем ещё несколько секунд: иначе плавающее окно исчезнет
    // ровно в тот момент, когда человеку нужно прочитать причину.
    const delay = error ? 6000 : 0;
    const timer = setTimeout(() => {
      native?.hudHide?.();
      setHudNativeOn(false);
    }, delay);
    return () => clearTimeout(timer);
  }, [state, hudAllowed, error]);

  useEffect(() => {
    if (!hudAllowed) return;
    const native = window.zspeakly?.native;
    if (!native?.hudUpdate) return;
    const now = Date.now();
    // уровень приходит по 30 кадров в секунду — в окно отправляем реже
    if (state === 'listening' && now - lastHudSent.current < 100) return;
    lastHudSent.current = now;
    // Ошибку плашка показывает двумя строками и сама становится выше
    // (main увеличивает окно по флагу error), поэтому текст не обрезаем.
    const hintFull = error?.hint || '';
    native.hudUpdate({
      state,
      level,
      elapsed,
      draft,
      // движок нужен плашке, чтобы не обещать живой текст там, где его нет
      engine,
      // а этот флаг — когда живой текст действительно включён
      live: liveText,
      error: error?.title || '',
      hint: hintFull,
      hintFull,
    });
  }, [state, level, elapsed, draft, error, hudAllowed, engine, liveText]);

  // Сообщаем main, что реально происходит: от этого зависят пункт
  // «Остановить диктовку» в трее и поведение глобального сочетания.
  useEffect(() => {
    window.zspeakly?.native?.dictationState?.(state);
  }, [state]);

  // Трей тоже говорит правду: пока «горячий микрофон» держит устройство
  // открытым, это видно в его подсказке и меню.
  useEffect(() => {
    window.zspeakly?.native?.micWarm?.(micWarmState === 'open');
  }, [micWarmState]);

  // «Крестик» на плавающем окне: запись продолжается, но индикатор переезжает
  // внутрь окна приложения — иначе остановить запись было бы нечем.
  useEffect(() => {
    const native = window.zspeakly?.native;
    if (!native?.onHudClosed) return undefined;
    return native.onHudClosed(() => {
      hudHiddenByUser.current = true;
      setHudNativeOn(false);
    });
  }, []);

  // Кнопка «стоп» на плавающем индикаторе живёт в другом окне и просит
  // остановить запись через main — обрабатываем так же, как горячую клавишу.
  useEffect(() => {
    const native = window.zspeakly?.native;
    if (!native?.onDictationStop) return undefined;
    return native.onDictationStop(() => {
      if (recRef.current) stop();
    });
  }, [stop]);

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
      nativeHud: hudAllowed && hudNativeOn,
      engine,
      // видно в настройках: держим ли микрофон открытым прямо сейчас
      micWarmState,
      hasWebSpeech,
      start,
      stop,
      toggle,
      finish,
      clearError: () => setError(null),
      setHudOpen,
      formatK,
      askAgent,
    }),
    [state, draft, level, error, last, mode, elapsed, hudOpen, hudAllowed, hudNativeOn, engine, micWarmState, start, stop, toggle, finish, askAgent],
  );

  return <DictationContext.Provider value={value}>{children}</DictationContext.Provider>;
}

export function useDictation() {
  const ctx = useContext(DictationContext);
  if (!ctx) throw new Error('useDictation must be used inside DictationProvider');
  return ctx;
}

export default DictationProvider;
