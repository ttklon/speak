/**
 * Диктовка: глобальный хоткей (удержание), поток Web Speech / whisper.cpp,
 * уровень микрофона, история, статистика, «вставка» в активное поле.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createRecognizer, engineName, hasNativeStt, hasWebSpeech, langTag } from '../lib/recognition/engine.js';
import { formatLiveDraft } from '../lib/recognition/liveDraft.js';
import { createMicWarm } from '../lib/audio/micWarm.js';
import { applyDictionary, formatK, postProcess, words } from '../lib/utils.js';
// Вставка в поле самого приложения: если человек диктует, стоя курсором в
// поиске или заметке, текст должен попасть туда, а не в предыдущее окно.
import { insertIntoFocusedField } from '../lib/insertLocal.js';
import { useAppData } from './AppDataProvider.jsx';
import { OPS, llmRewrite, polishDictation } from '../lib/ai/textops.js';
import { describeScreen } from '../lib/ai/vision.js';
import { playCue } from '../lib/feedback.js';
import { diag } from '../lib/diagnostics.js';
import { useToast } from './ToastProvider.jsx';

/**
 * Предпросмотр диктовки: читаем результат системным голосом Windows.
 *
 * Раньше сбой синтеза речи был неотличим от успеха: `speechSynthesis.speak()`
 * ничего не обещает, а в системе может не оказаться ни одного голоса. Теперь
 * вызывающий код узнаёт, что чтение не пошло, и может сказать об этом.
 */
function speak(text, language = 'ru', voiceURI = '', onFail = null) {
  if (!text) return;
  if (typeof speechSynthesis === 'undefined') {
    onFail?.('в системе нет синтеза речи');
    return;
  }
  try {
    speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    const map = {
      ru: 'ru-RU', en: 'en-US', de: 'de-DE', es: 'es-ES', fr: 'fr-FR',
      zh: 'zh-CN', ja: 'ja-JP', tr: 'tr-TR', kk: 'kk-KZ', uk: 'uk-UA',
    };
    utter.lang = map[language] || language;
    utter.rate = 1.02;
    let started = false;
    utter.onstart = () => {
      started = true;
    };
    utter.onerror = (event) => {
      // «interrupted»/«canceled» — это мы сами отменили предыдущую фразу
      const reason = String(event?.error || '');
      if (!started && !/interrupt|cancel/i.test(reason)) onFail?.(reason || 'синтез речи не ответил');
    };
    if (voiceURI) {
      const match = speechSynthesis.getVoices?.().find((v) => v.voiceURI === voiceURI);
      if (match) {
        utter.voice = match;
        utter.lang = match.lang || utter.lang;
      }
    }
    speechSynthesis.speak(utter);
    // Голосов может не быть вовсе: тогда speak() просто ничего не делает.
    setTimeout(() => {
      if (started) return;
      try {
        if (speechSynthesis.speaking || speechSynthesis.pending) return;
      } catch {
        /* ignore */
      }
      onFail?.('голос не найден');
    }, 1600);
  } catch (err) {
    onFail?.(String(err?.message || err));
  }
}

const DictationContext = createContext(null);

export function DictationProvider({ children }) {
  const { settings, dictionary, addDictation, recordWords, updateSettings, updateDictation } = useAppData();
  const [state, setState] = useState('idle'); // idle | listening | processing | done
  const [draft, setDraft] = useState(''); // живой текст
  const [level, setLevel] = useState(0);
  const [error, setError] = useState(null);
  const [last, setLast] = useState(null); // {text, createdAt, words, durationMs}
  const [mode, setMode] = useState('hold');
  const [elapsed, setElapsed] = useState(0);
  const [hudOpen, setHudOpen] = useState(false);
  // пауза посреди диктовки: микрофон открыт, звук не копится
  const [paused, setPaused] = useState(false);
  // сколько уже идёт распознавание — человек должен видеть, что приложение
  // работает, а не зависло на 40 секунд
  const [processingMs, setProcessingMs] = useState(0);
  // прогресс по фрагментам длинной записи: { done, total }
  const [sttProgress, setSttProgress] = useState(null);
  // живая расшифровка возможна только с whisper.cpp: браузерный движок сам
  // отдаёт промежуточный текст, а whisper нужно спрашивать повторно
  const liveText = settings.liveWhisper !== false && hasNativeStt();
  // отдельное окно индикатора реально показано (а не просто «должно быть»)
  const [hudNativeOn, setHudNativeOn] = useState(false);
  const hudHiddenByUser = useRef(false);

  const recRef = useRef(null);
  const startedAt = useRef(0);
  // пауза: сколько времени запись стояла и когда встала
  const pausedTotal = useRef(0);
  const pausedAt = useRef(0);
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
  // предупреждение о чтении вслух — не чаще раза в 5 минут
  const readFailWarnedAt = useRef(0);
  // id последней записи в истории: нужен, чтобы поздний ответ модели
  // (после бюджета полировки) обновил именно эту запись, а не чужую
  const lastItemId = useRef('');
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
        // Бюджет полировки. Раньше здесь стояло «ждём до 6 секунд» — и человек
        // получал текст через шесть секунд после того, как замолчал, хотя
        // распознавание заняло доли секунды. Теперь ждём не дольше бюджета
        // (по умолчанию 1,5 с): если модель не успела — вставляем текст после
        // офлайн-правил и честно говорим об этом, а ответ модели доходит в
        // историю, когда будет готов.
        const budget = Math.max(300, Number(settingsRef.current.aiPolishBudgetMs) || 1500);
        const polishPromise = polishDictation(cleaned, settingsRef.current, { timeout: 6000 });
        let timedOut = false;
        const better = await Promise.race([
          polishPromise,
          new Promise((resolve) => {
            setTimeout(() => {
              timedOut = true;
              resolve(null);
            }, budget);
          }),
        ]);
        if (timedOut) {
          // Не блокируем вставку: текст уже готов и правильный. Когда модель
          // всё-таки ответит — обновим запись в истории, чтобы человек видел
          // «как надо», но в чужое окно второй раз ничего не печатаем.
          polishPromise
            .then((late) => {
              if (!late) return;
              const improved = OPS.clean(late);
              if (!improved || improved === cleaned) return;
              const id = lastItemId.current;
              if (id && updateDictation) updateDictation(id, { text: improved, words: words(improved) });
              diag.info('stt', 'Модель улучшила диктовку после вставки', {
                before: cleaned.length,
                after: improved.length,
              });
            })
            .catch(() => {});
          diag.warn('stt', 'Модель не успела за бюджет — вставлены офлайн-правила', { budget });
        }
        if (better) {
          cleaned = OPS.clean(better);
          diag.info('stt', 'Диктовку довела локальная модель', {
            before,
            after: cleaned.length,
            model: settingsRef.current.aiModel || '',
          });
        } else if (!timedOut) {
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
        lastItemId.current = item.id;
        addDictation(item);
        recordWords(item.words, durationMs);
        // Вставка в активное окно. Раньше она жила только в onEnd движка,
        // и при остановке через кнопку или отпускание хоткея текст молча
        // оставался в истории — в приложении он не появлялся.
        const native = window.zspeakly?.native;
        // 1) Поле внутри приложения в фокусе — вставляем прямо в него.
        //    Никакого буфера и никаких чужих окон: это то место, где человек пишет.
        const local =
          insert && sessionOpts.current.insert !== false
            ? insertIntoFocusedField(cleaned)
            : { inserted: false };
        if (local.inserted) {
          diag.info('stt', 'Диктовка вставлена в поле приложения', { chars: cleaned.length });
        }
        if (!local.inserted && insert && sessionOpts.current.insert !== false && native?.insertText) {
          // main отвечает false, если SendKeys не сработал (окно с правами
          // администратора, игра, защищённое поле). Текст уже в буфере —
          // говорим об этом, иначе диктовка выглядит «сломанной».
          Promise.resolve(native.insertText(cleaned))
            .then((res) => {
              // Вставка «без буфера» может оборваться на середине текста:
              // тогда буфер не трогали, дублировать нечего, но человек должен
              // знать, что часть фразы уже в окне, а часть — только в истории.
              if (res && typeof res === 'object' && res.partial > 0) {
                pushToast({
                  title: `Введено ${res.partial} из ${res.total || '?'} символов`,
                  description:
                    'Ввод прервался на середине. Остаток не вставляю, чтобы не задвоить, — он есть в истории диктовок.',
                  tone: 'warn',
                  ttl: 12000,
                });
                return;
              }
              if (res === false) {
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
          const readOnce = Date.now() - readFailWarnedAt.current > 5 * 60 * 1000;
          speak(cleaned, settingsRef.current.language, settingsRef.current.readAloudVoice || '', (reason) => {
            diag.warn('stt', 'Чтение вслух не сработало', { reason });
            if (!readOnce) return;
            readFailWarnedAt.current = Date.now();
            pushToast({
              title: 'Чтение вслух не сработало',
              description:
                'В системе не нашлось голоса для русского языка. Windows: «Параметры → Время и язык → Речь → Добавить голоса».',
              tone: 'warn',
              ttl: 11000,
            });
          });
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
      pausedTotal.current = 0;
      pausedAt.current = 0;
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
        onPartial: ({ text, interim, truncated }) => {
          const composed = [text, interim].filter(Boolean).join(' ');
          // живая расшифровка может прийти по хвосту записи — тогда начало
          // помечено многоточием, чтобы черновик не выдавал себя за всё
          const shown = formatLiveDraft({ text: composed, truncated: truncated === true });
          draftRef.current = shown;
          setDraft(shown);
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
      setPaused(false);
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
    setPaused(false);
    // запись завершена — пауз больше нет, длительность дальше считать нечего
    if (pausedAt.current) pausedAt.current = 0;
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

  /**
   * Пауза диктовки. Раньше её не было вовсе: остановить запись можно было
   * только целиком, а потом начинать заново. Теперь звук просто перестаёт
   * копиться — уже сказанное остаётся, микрофон не переоткрывается.
   */
  const pause = useCallback(() => {
    const rec = recRef.current;
    if (!rec?.pause) return;
    rec.pause();
    pausedAt.current = Date.now();
    setPaused(true);
    setLevel(0);
  }, []);

  const resume = useCallback(() => {
    const rec = recRef.current;
    if (!rec?.resume) return;
    rec.resume();
    if (pausedAt.current) {
      pausedTotal.current += Date.now() - pausedAt.current;
      pausedAt.current = 0;
    }
    setPaused(false);
  }, []);

  /**
   * «Отменить распознавание»: убить текущий проход whisper, не дожидаясь
   * минуты. Текст не вставляется — человек сам решил прервать.
   */
  const cancelProcessing = useCallback(() => {
    try {
      window.zspeakly?.native?.cancelTranscribe?.();
    } catch {
      /* ignore */
    }
    diag.info('stt', 'Распознавание отменено пользователем');
    recRef.current = null;
    setPaused(false);
    setState('idle');
    setLevel(0);
  }, []);

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

  // Таймер длительности. Время на паузе не должно «идти»: иначе человек
  // видит, что запись продолжается, хотя звук уже не пишется.
  useEffect(() => {
    if (state !== 'listening') return undefined;
    const t = setInterval(() => {
      const now = Date.now();
      const hold = pausedAt.current ? now - pausedAt.current : 0;
      setElapsed(Math.max(0, now - startedAt.current - pausedTotal.current - hold));
    }, 100);
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

  // Секундомер распознавания: без него «Транскрипция…» выглядела зависанием.
  useEffect(() => {
    if (state !== 'processing') {
      setProcessingMs(0);
      setSttProgress(null);
      return undefined;
    }
    const started = Date.now();
    setProcessingMs(0);
    const t = setInterval(() => setProcessingMs(Date.now() - started), 200);
    return () => clearInterval(t);
  }, [state]);

  // Автозагрузка модели на первой установке: человек должен видеть, что
  // приложение не «висит», а качает 142 МБ, и что диктовка заработает сама.
  useEffect(() => {
    const native = window.zspeakly?.native;
    if (!native?.onModelProgress) return undefined;
    let lastAt = 0;
    let announced = false;
    return native.onModelProgress((p) => {
      if (!p?.auto) return;
      if (p.done) {
        if (p.ok) {
          pushToast({
            title: 'Модель распознавания готова',
            description: 'Диктовка работает офлайн. Можно говорить.',
            tone: 'success',
            ttl: 8000,
          });
        } else if (p.reason) {
          pushToast({
            title: 'Модель не скачалась',
            description: String(p.reason).slice(0, 160),
            tone: 'warn',
            ttl: 12000,
          });
        }
        return;
      }
      const now = Date.now();
      if (now - lastAt < 2000) return;
      lastAt = now;
      const percent = Number(p.percent || 0);
      const what = p.id === 'engine' ? 'движок распознавания' : `модель ${p.id || 'base'}`;
      pushToast({
        title: `Скачиваю ${what} — ${percent}%`,
        description: announced ? '' : 'Это один раз: дальше ZSpeakly работает офлайн.',
        tone: 'info',
        ttl: 2600,
      });
      announced = true;
    });
  }, [pushToast]);

  // Автоподбор модели: main сам перешёл на быструю модель, если проход по
  // короткой записи оказался долгим. Человеку остаётся только увидеть, что
  // стало быстрее, — и настройка в окне должна совпасть с тем, что в main.
  useEffect(() => {
    const native = window.zspeakly?.native;
    if (!native?.onAutoTune) return undefined;
    return native.onAutoTune((p) => {
      if (!p?.to) return;
      updateSettings?.({ whisperModel: p.to });
      const secs = Number(p.seconds || 0);
      // Два повода переключить модель: после долгого прохода (замер) и сразу
      // при запуске, если на этой машине модель заведомо тяжёлая.
      const byHardware = p.reason === 'hardware' || !p.from || !Number(p.ms || 0);
      pushToast({
        title: byHardware ? `Модель «${p.to}» подобрана под этот компьютер` : `Модель «${p.to}» — быстрее`,
        description: byHardware
          ? p.why || 'Взял модель, которая успевает за вашей речью. Поменять можно в «Функциях».'
          : `«${p.from}» распознавала ${secs ? `${secs} с речи` : 'короткую фразу'} за ${(
              Number(p.ms || 0) / 1000
            ).toFixed(1)} с. Переключил автоматически, качество текста для диктовки то же.`,
        tone: 'success',
        ttl: 12000,
      });
    });
  }, [pushToast, updateSettings]);

  // Прогресс по фрагментам: «2 из 4» вместо безымянного ожидания
  useEffect(() => {
    const native = window.zspeakly?.native;
    if (!native?.onSttProgress) return undefined;
    return native.onSttProgress((p) => {
      if (p && p.total > 1) setSttProgress({ done: p.done, total: p.total });
    });
  }, []);

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
      paused,
      processingMs,
      draft,
      // движок нужен плашке, чтобы не обещать живой текст там, где его нет
      engine,
      // а этот флаг — когда живой текст действительно включён
      live: liveText,
      error: error?.title || '',
      hint: hintFull,
      hintFull,
    });
  }, [state, level, elapsed, draft, error, hudAllowed, engine, liveText, paused, processingMs]);

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

  // Пауза и отмена из плавающей плашки: человек смотрит в чужое окно,
  // и ему не нужно возвращаться в ZSpeakly.
  useEffect(() => {
    const native = window.zspeakly?.native;
    if (!native?.onDictationPause) return undefined;
    return native.onDictationPause((p) => {
      if (!recRef.current) return;
      if (p?.paused) pause();
      else resume();
    });
  }, [pause, resume]);

  useEffect(() => {
    const native = window.zspeakly?.native;
    if (!native?.onDictationCancel) return undefined;
    return native.onDictationCancel(() => {
      if (state === 'processing') cancelProcessing();
    });
  }, [state, cancelProcessing]);

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
      paused,
      processingMs,
      sttProgress,
      nativeHud: hudAllowed && hudNativeOn,
      engine,
      // видно в настройках: держим ли микрофон открытым прямо сейчас
      micWarmState,
      hasWebSpeech,
      start,
      stop,
      toggle,
      pause,
      resume,
      cancelProcessing,
      finish,
      clearError: () => setError(null),
      setHudOpen,
      formatK,
      askAgent,
    }),
    [
      state, draft, level, error, last, mode, elapsed, hudOpen, paused, processingMs, sttProgress,
      hudAllowed, hudNativeOn, engine, micWarmState, start, stop, toggle, pause, resume, cancelProcessing, finish, askAgent,
    ],
  );

  return <DictationContext.Provider value={value}>{children}</DictationContext.Provider>;
}

export function useDictation() {
  const ctx = useContext(DictationContext);
  if (!ctx) throw new Error('useDictation must be used inside DictationProvider');
  return ctx;
}

export default DictationProvider;
