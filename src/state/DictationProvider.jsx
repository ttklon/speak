/**
 * Диктовка: глобальный хоткей (удержание), поток Web Speech / whisper.cpp,
 * уровень микрофона, история, статистика, «вставка» в активное поле.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createRecognizer, engineName, hasNativeStt, hasWebSpeech, langTag } from '../lib/recognition/engine.js';
import { formatLiveDraft } from '../lib/recognition/liveDraft.js';
import { resolveLiveDraft } from '../lib/liveDraftPolicy.js';
// авто-стоп: в режиме «переключатель» запись завершается сама после тишины,
// иначе забытая запись тянет минуты пустого звука в распознавание
import { AUTO_STOP_IDLE_MS, autoStopNotice, createSilenceWatch } from '../lib/autoStop.js';
import { createMicWarm } from '../lib/audio/micWarm.js';
import { applyDictionary, formatK, truncate, words } from '../lib/utils.js';
// Вставка в поле самого приложения: если человек диктует, стоя курсором в
// поиске или заметке, текст должен попасть туда, а не в предыдущее окно.
import { insertIntoFocusedField } from '../lib/insertLocal.js';
import { tierForModel } from '../lib/modelTiers.js';
import { useAppData } from './AppDataProvider.jsx';
import { OPS, cleanLines, llmRewrite, polishDictation } from '../lib/ai/textops.js';
import { applyVoiceCommands } from '../lib/voiceCommands.js';
// оформление под место вставки: в мессенджере точка в конце лишняя, в
// редакторе кода — заглавная буква; решается без человека и без модели
import { formatForApp, resolveAppStyle } from '../lib/appFormat.js';
import { expandSnippet } from '../lib/snippets.js';
import { createPolishGate } from '../lib/ai/polishGate.js';
import { decodeAudioFile } from '../lib/audio/decodeFile.js';
import { readSelectionText, writeSelectionText } from '../lib/hotkeys/selection.js';
import { runInstruction } from '../lib/ai/instructions.js';
import { dropSelfCorrections } from '../lib/ai/selfCorrect.js';
import {
  COMMAND_ERRORS,
  commandInstruction,
  commandTitle,
} from '../lib/voiceCommandMode.js';
import {
  FILE_ERRORS,
  fileTitle,
  formatDuration,
  mergeFileText,
  planWindows,
  slicePcm,
  validateAudioFile,
} from '../lib/recognition/audioFile.js';
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
  const { settings, dictionary, snippets, addDictation, recordWords, updateSettings, updateDictation } =
    useAppData();
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
  // «Файл в текст»: что именно происходит сейчас — расшифровка, сколько
  // фрагментов из скольких, и последние распознанные слова (чтобы окно не
  // молчало минуту на длинной встрече)
  const [fileJob, setFileJob] = useState(null);
  // Живая расшифровка возможна только с локальным движком: браузерный сам
  // отдаёт промежуточный текст, а whisper нужно спрашивать повторно. Включать
  // её или нет — решает приложение по режиму и замерам (lib/liveDraftPolicy.js):
  // черновик — это лишний проход движка, и на «Максимуме» он отбирает процессор
  // у готового текста.
  const liveDraft = resolveLiveDraft({
    setting: settings.liveWhisper,
    model: settings.whisperModel,
    hasNative: hasNativeStt(),
  });
  const liveText = liveDraft.enabled;
  // отдельное окно индикатора реально показано (а не просто «должно быть»)
  const [hudNativeOn, setHudNativeOn] = useState(false);
  const hudHiddenByUser = useRef(false);

  const recRef = useRef(null);
  // сторож тишины текущей записи (только для режима «переключатель»)
  const silenceRef = useRef(null);
  // как начата запись: удержание клавиши или переключатель
  const modeRef = useRef('hold');
  // stop нужен внутри обработчика уровня, а объявлен ниже — держим ссылку
  const stopRef = useRef(null);
  const startedAt = useRef(0);
  // пауза: сколько времени запись стояла и когда встала
  const pausedTotal = useRef(0);
  const pausedAt = useRef(0);
  const draftRef = useRef('');
  const finalRef = useRef('');
  const settingsRef = useRef(settings);
  // политика живой расшифровки нужна внутри обработчиков — держим её в ref,
  // чтобы не пересоздавать замыкания на каждое измерение
  const liveDraftRef = useRef(liveDraft);
  liveDraftRef.current = liveDraft;
  const dictRef = useRef(dictionary);
  // быстрые блоки: «моя подпись» → готовый текст
  const snippetsRef = useRef(snippets);
  const stopFallback = useRef(null);
  // «Ворота» полировки: помнят, успевает ли модель, и режут лишнее ожидание.
  const gateRef = useRef(null);
  if (!gateRef.current) {
    gateRef.current = createPolishGate({ budgetMs: Number(settings.aiPolishBudgetMs) || 900 });
  }
  // смена бюджета или модели — начинаем с чистого листа: новая модель может
  // быть быстрее прежней, и «не ждём вовсе» было бы несправедливо
  useEffect(() => {
    gateRef.current = createPolishGate({ budgetMs: Number(settings.aiPolishBudgetMs) || 900 });
  }, [settings.aiPolishBudgetMs, settings.aiModel, settings.aiEndpoint]);
  const finishing = useRef(false);
  // опции текущей диктовки (нужны при остановке: вставлять текст или нет)
  const sessionOpts = useRef({});
  // Командный режим: выделенный текст, к которому применится сказанное.
  // Читаем его на нажатии — к моменту остановки записи выделение в чужом окне
  // уже может быть снято (клик по плашке, переключение окна).
  const commandRef = useRef('');
  // кадр экрана для «диктовки с учётом экрана» (в памяти, не на диске)
  const screenContextRef = useRef(null);
  // термины, которые локальная модель разглядела на экране: уходят в whisper
  // как подсказка. Живут до следующего кадра и нигде не сохраняются.
  const screenTermsRef = useRef('');

  // Куда попадёт текст: спрашиваем на старте записи, в фоне. На остановке
  // берём готовый ответ — иначе ожидание вставки выросло бы на запрос к окну,
  // а обещание «20 секунд речи за 5 секунд» ломается на ровном месте.
  const targetRef = useRef(null);

  useEffect(() => {
    settingsRef.current = settings;
    dictRef.current = dictionary;
    snippetsRef.current = snippets;
  }, [settings, dictionary, snippets]);

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


  const stopAtRef = useRef(0);

  const finish = useCallback(
    async (
      text,
      { insert = true, sttMs = 0, spoken = true, spokenSeconds = 0, sttMeta = null } = {},
    ) => {
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
      // Голосовые знаки и команды: «запятая», «с новой строки», «удалить
      // последнее слово». Раньше они попадали в текст словами — человеку
      // приходилось бросать диктовку и править руками.
      // Только для сказанного: ответ агента — это написанный моделью текст,
      // и превращать в нём «запятую» в знак было бы ошибкой.
      const commanded = spoken
        ? applyVoiceCommands(corrected, { language: settingsRef.current.language })
        : corrected;
      // Чистка — построчно: иначе схлопнулись бы переносы, сказанные голосом.
      let cleaned = polishing ? cleanLines(commanded) : commanded.trim();
      // Оговорки: «встреча в четыре… то есть в три» — в тексте остаётся то,
      // что человек имел в виду. Правило осторожное: убираем только когда
      // замена очевидна (число, имя, день недели), уточнение не трогаем.
      if (spoken && cleaned) {
        const fixed = dropSelfCorrections(cleaned);
        if (fixed.fixes > 0) {
          cleaned = fixed.text;
          diag.info('stt', 'Оговорка убрана', { fixes: fixed.fixes, chars: cleaned.length });
        }
      }
      // Быстрый блок: сказал триггер целиком — вставляем готовый текст вместо
      // фразы. Срабатывает только на точное совпадение: «поставь мою подпись
      // в конце» должно остаться речью, а не превратиться в подпись.
      let snippetHit = null;
      if (spoken && insert && sessionOpts.current.insert !== false) {
        const expanded = expandSnippet(cleaned, snippetsRef.current || []);
        if (expanded.snippet) {
          snippetHit = expanded.snippet;
          cleaned = expanded.text;
          diag.info('stt', 'Быстрый блок развёрнут', {
            trigger: snippetHit.trigger,
            chars: cleaned.length,
          });
        }
      }
      // ── Командный режим ───────────────────────────────────────────────
      // Сказанное здесь — не текст для вставки, а указание к выделению.
      // Поэтому обычный путь диктовки (сниппеты, оформление под окно,
      // полировка, вставка) не выполняется вовсе: иначе команда «сократи»
      // вставилась бы в чужое окно словом «сократи».
      if (sessionOpts.current.command) {
        sessionOpts.current.command = false;
        const selection = String(commandRef.current || '').trim();
        commandRef.current = '';
        const instruction = commandInstruction(cleaned);
        setDraft('');
        draftRef.current = '';
        finalRef.current = '';
        if (!selection || !instruction) {
          const reason = !selection ? COMMAND_ERRORS['no-selection'] : COMMAND_ERRORS['empty-command'];
          pushToast({
            title: reason.title,
            description: reason.message || reason.description,
            tone: 'warn',
            ttl: 9000,
          });
          diag.warn('stt', 'Команда голосом не выполнена', {
            selection: selection.length,
            command: cleaned.length,
          });
          setState('idle');
          release();
          return null;
        }
        setState('processing');
        const commandStart = Date.now();
        let result = '';
        let note = '';
        try {
          const answer = await runInstruction(instruction, selection, settingsRef.current);
          result = typeof answer === 'string' ? answer : String(answer?.text || '');
          note = typeof answer === 'object' && answer ? String(answer.note || '') : '';
        } catch (err) {
          diag.warn('stt', 'Команда голосом: модель не ответила', { reason: String(err?.message || err) });
        }
        if (!result || result.trim() === selection.trim()) {
          pushToast({
            title: COMMAND_ERRORS['no-change'].title,
            description: note || COMMAND_ERRORS['no-change'].description,
            tone: 'warn',
          });
          diag.info('stt', 'Команда голосом без изменений', { command: cleaned });
          setState('idle');
          release();
          return null;
        }
        const placed = await writeSelectionText(result);
        const item = {
          text: result,
          durationMs: Math.max(400, Date.now() - startedAt.current),
          words: words(result),
          createdAt: Date.now(),
          id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          language: settingsRef.current.language,
          source: 'command',
          command: cleaned,
          sttMs: sttMs || undefined,
        };
        addDictation(item);
        recordWords(item.words, 0);
        diag.info('stt', 'Команда голосом выполнена', {
          command: cleaned,
          chars: result.length,
          ms: Date.now() - commandStart,
          placed,
        });
        pushToast({
          title: placed === 'failed' ? 'Готово, но вставить не удалось' : `Готово: ${commandTitle(cleaned)}`,
          description: [truncate(result, 90), note].filter(Boolean).join(' — '),
          tone: placed === 'failed' || note ? 'warn' : 'success',
          ttl: 8000,
        });
        setState('done');
        setTimeout(() => setState((s) => (s === 'done' ? 'idle' : s)), 2200);
        release();
        return item;
      }

      // Куда и как вставляем — решаем один раз: этот же стиль нужен и позднему
      // ответу модели (он приходит уже после вставки и обновляет историю),
      // иначе в истории оказался бы текст с точкой, которой в окне нет.
      const where =
        insert && sessionOpts.current.insert !== false
          ? resolveAppStyle(targetRef.current || {})
          : { style: 'neutral', why: '', label: '' };
      // Вторая стадия («Переписывать диктовку моделью»): офлайн-правила уже
      // дали текст, локальная модель доводит формулировки. Модель может
      // не ответить — тогда остаётся результат правил, диктовка не ломается.
      // Развёрнутый блок моделью не переписываем: это авторский текст, а не
      // расшифровка, — правки в подписи или реквизитах были бы порчей.
      if (polishing && cleaned && !snippetHit && settingsRef.current.aiDictationRewrite === true) {
        setState('processing');
        const before = cleaned.length;
        // Бюджет полировки. Раньше здесь стояло «ждём до 6 секунд» — и человек
        // получал текст через шесть секунд после того, как замолчал, хотя
        // распознавание заняло доли секунды. Теперь ждём не дольше бюджета
        // (по умолчанию 1,5 с): если модель не успела — вставляем текст после
        // офлайн-правил и честно говорим об этом, а ответ модели доходит в
        // историю, когда будет готов.
        // Сколько ждать — решает «ворота» полировки: если модель уже дважды
        // не успела, ждать не будем вовсе (текст вставляется сразу, доведённый
        // вариант придёт в историю). Так слабая модель не тормозит диктовку.
        const gate = gateRef.current;
        const budget = gate.budget;
        const polishStarted = Date.now();
        const polishPromise = polishDictation(cleaned, settingsRef.current, { timeout: 6000 });
        let timedOut = false;
        let better = null;
        if (budget > 0) {
          better = await Promise.race([
            polishPromise,
            new Promise((resolve) => {
              setTimeout(() => {
                timedOut = true;
                resolve(null);
              }, budget);
            }),
          ]);
          gate.record({ timedOut, ms: Date.now() - polishStarted });
        } else {
          // не ждём: модель медленная, вставка не должна страдать
          timedOut = true;
          gate.record({ timedOut: true, ms: 0 });
        }
        if (timedOut) {
          // Не блокируем вставку: текст уже готов и правильный. Когда модель
          // всё-таки ответит — обновим запись в истории, чтобы человек видел
          // «как надо», но в чужое окно второй раз ничего не печатаем.
          polishPromise
            .then((late) => {
              if (!late) return;
              const improved = formatForApp(cleanLines(late), where.style);
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
          cleaned = cleanLines(better);
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
                description:
                  '«Умная полировка» включена, но локальная модель не настроена — текст чистят офлайн-правила. Включить: «Настройки → Диктовка → Модель для инструкций».',
                tone: 'warn',
                ttl: 9000,
              });
            } else {
              pushToast({
                title: 'Модель не ответила',
                description: 'Диктовка очищена офлайн-правилами. Проверьте, запущена ли Ollama: «Настройки → Диктовка → Модель для инструкций».',
                tone: 'warn',
                ttl: 9000,
              });
            }
          }
        }
      }
      // Оформление под окно, куда вставляем: мессенджер — без точки в конце,
      // редактор кода — без заглавной и точки, письмо — с заглавной и точкой.
      // Ничего не переписываем, только знаки и регистр первой буквы.
      if (cleaned && where.style !== 'neutral') {
        const shaped = formatForApp(cleaned, where.style);
        if (shaped && shaped !== cleaned) {
          diag.info('stt', 'Оформление под окно', {
            style: where.style,
            why: where.why,
            before: cleaned.length,
            after: shaped.length,
          });
          cleaned = shaped;
        }
      }
      const durationMs = Math.max(400, Date.now() - startedAt.current);
      // Считаем один раз и обнуляем: иначе повторный проход по той же записи
      // (правка, пересборка истории) приписал бы ей новое время ожидания.
      const waitFromStop = () => {
        const at = stopAtRef.current;
        stopAtRef.current = 0;
        return at ? Math.max(0, Date.now() - at) : 0;
      };
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
        // сколько секунд человек говорил: вместе с sttMs это и есть «успевает ли
        // модель», по этим числам выбирается режим и это же видно в настройках
        spokenMs: spokenSeconds > 0 ? Math.round(spokenSeconds * 1000) : undefined,
        // чем считали: прогретый сервер или холодный whisper-cli, и во сколько
        // обошлась подготовка звука — без этого «долго» некуда девать
        sttMode: sttMeta?.mode || undefined,
        sttParts: sttMeta?.parts > 1 ? sttMeta.parts : undefined,
        // сколько кусков посчитали заранее, пока человек ещё говорил
        sttPreParts: sttMeta?.timeline?.preParts > 0 ? sttMeta.timeline.preParts : undefined,
        sttModel: sttMeta?.model || undefined,
        sttWarm: typeof sttMeta?.timeline?.warm === 'boolean' ? sttMeta.timeline.warm : undefined,
        // Отпустил клавишу → текст готов. Включает распознавание, чистку и
        // вставку, поэтому именно это число сравнивается с обещанными пятью
        // секундами (у старых записей его нет — считаем по sttMs).
        waitMs: waitFromStop() || undefined,
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
              // main теперь отвечает объектом: способ вставки, причина отказа.
              // Молчаливое «не вставилось» — это и есть «ничего не работает»,
              // поэтому причина называется прямо, а не «что-то пошло не так».
              if (res === false || (res && typeof res === 'object' && res.ok === false)) {
                const why =
                  res && typeof res === 'object' && res.reason
                    ? `Причина: ${res.reason}.`
                    : 'Автоматическая вставка не сработала.';
                pushToast({
                  title: 'Текст в буфере — нажмите Ctrl+V',
                  description: `${why} Текст не потерян: он в буфере обмена и в истории.`,
                  tone: 'warn',
                  ttl: 12000,
                });
                diag.warn('stt', 'Вставка не удалась', {
                  method: (res && res.method) || '',
                  reason: (res && res.reason) || '',
                  helper: (res && res.helper && res.helper.reason) || '',
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

  /**
   * «Файл в текст»: готовая запись → текст в истории, без вставки в окно.
   *
   * Тот же движок, что у диктовки, но звук приходит из файла: декодируем его в
   * браузере (WAV/MP3/M4A/OGG/FLAC/WEBM), режем на куски по 30 с с перекрытием
   * и склеиваем текст без повторов. В окно ничего не вставляется намеренно:
   * человек расшифровывает встречу, а не диктует в чужое приложение.
   */
  const fileJobRef = useRef(null);
  const transcribeFile = useCallback(
    async (file) => {
      const native = typeof window !== 'undefined' ? window.zspeakly?.native : null;
      if (!native?.transcribePcm) {
        pushToast({ ...FILE_ERRORS['no-engine'], tone: 'warn', ttl: 12000 });
        return null;
      }
      const name = fileTitle(file?.name);
      const fits = validateAudioFile({ name: file?.name, size: file?.size });
      if (!fits.ok) {
        pushToast({ title: 'Этот файл не подойдёт', description: fits.message, tone: 'warn', ttl: 11000 });
        return null;
      }
      const job = { cancelled: false };
      fileJobRef.current = job;
      setFileJob({ name, phase: 'decode', done: 0, total: 0, preview: '' });
      const startedAtMs = Date.now();

      let decoded;
      try {
        decoded = await decodeAudioFile(file);
      } catch (err) {
        fileJobRef.current = null;
        setFileJob(null);
        const key = String(err?.message || '') === 'decode' ? 'decode' : 'failed';
        diag.warn('stt', 'Файл не разобрался', { reason: String(err?.message || err) });
        pushToast({ ...FILE_ERRORS[key], tone: 'warn', ttl: 12000 });
        return null;
      }
      // Пределы проверяем ещё раз по настоящей длительности: размер файла о ней
      // не говорит (час MP3 весит меньше десяти минут WAV).
      const byDuration = validateAudioFile({ name: file?.name, size: 0, durationMs: decoded.durationMs });
      if (!byDuration.ok) {
        fileJobRef.current = null;
        setFileJob(null);
        pushToast({ title: 'Запись слишком длинная', description: byDuration.message, tone: 'warn', ttl: 11000 });
        return null;
      }
      const windows = planWindows(decoded.durationMs);
      if (!windows.length) {
        fileJobRef.current = null;
        setFileJob(null);
        pushToast({ ...FILE_ERRORS.empty, tone: 'warn' });
        return null;
      }

      const lang = String(langTag(settingsRef.current.language) || 'ru-RU').slice(0, 2);
      const parts = [];
      let sttMs = 0;
      let failed = 0;
      for (let i = 0; i < windows.length; i += 1) {
        if (job.cancelled) break;
        const win = windows[i];
        setFileJob({ name, phase: 'run', done: i, total: windows.length, preview: mergeFileText(parts).slice(-240) });
        try {
          const res = await native.transcribePcm({
            pcm: slicePcm(decoded.pcm, { ...win, sampleRate: decoded.sampleRate }),
            durationMs: win.toMs - win.fromMs,
            lang,
            model: settingsRef.current.whisperModel,
            // словарь и подсказка — на весь файл: термины известны заранее, и
            // это тот случай, когда подсказка помогает, а не мешает
            useDictionary: true,
            contextPrompt: '',
          });
          if (res?.ok) {
            const text = String(res.text || '').trim();
            if (text) parts.push(text);
            else failed += 1;
            sttMs += Number(res.ms) || 0;
          } else {
            failed += 1;
          }
        } catch {
          failed += 1;
        }
        setFileJob({
          name,
          phase: 'run',
          done: i + 1,
          total: windows.length,
          preview: mergeFileText(parts).slice(-240),
        });
      }
      fileJobRef.current = null;
      setFileJob(null);

      if (job.cancelled) {
        diag.info('stt', 'Расшифровка файла отменена', { name });
        return null;
      }
      const merged = mergeFileText(parts);
      const corrected =
        settingsRef.current.dictionaryEnabled !== false ? applyDictionary(merged, dictRef.current) : merged;
      const text = corrected.trim();
      if (!text) {
        diag.warn('stt', 'Файл без речи', { name, failed, parts: windows.length });
        pushToast({ ...(failed === windows.length ? FILE_ERRORS.failed : FILE_ERRORS.empty), tone: 'warn', ttl: 11000 });
        return null;
      }
      const item = {
        text,
        durationMs: decoded.durationMs,
        words: words(text),
        createdAt: Date.now(),
        id: `f-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        language: settingsRef.current.language,
        source: 'file',
        fileName: name,
        sttMs: sttMs || undefined,
        sttModel: settingsRef.current.whisperModel,
        sttParts: windows.length > 1 ? windows.length : undefined,
      };
      addDictation(item);
      // Слова считаем в общую статистику, секунды — нет: это не продиктованная
      // речь, и «речи продиктовано» не должно расти от чужой записи.
      recordWords(item.words, 0);
      diag.info('stt', 'Файл расшифрован', {
        name,
        parts: windows.length,
        failed,
        words: item.words,
        durationMs: decoded.durationMs,
        ms: Date.now() - startedAtMs,
      });
      pushToast({
        title: 'Файл расшифрован',
        description: `${name} · ${formatDuration(decoded.durationMs)} · ${item.words} слов — в «Недавних»`,
        tone: 'success',
        ttl: 9000,
      });
      return item;
    },
    [addDictation, recordWords, pushToast],
  );

  const cancelFile = useCallback(() => {
    const job = fileJobRef.current;
    if (!job) return false;
    job.cancelled = true;
    return true;
  }, []);

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
      modeRef.current = opts.mode || 'hold';
      // В режиме удержания стоп даёт клавиша — сторож не нужен и только мешал бы
      // (человек думает над фразой, держа клавишу). В переключателе — нужен.
      silenceRef.current =
        modeRef.current === 'toggle'
          ? createSilenceWatch({ idleMs: AUTO_STOP_IDLE_MS, now: Date.now() })
          : null;
      setHudOpen(true);
      // Активное окно — заранее и не дожидаясь: к остановке ответ уже есть.
      targetRef.current = null;
      Promise.resolve(window.zspeakly?.native?.insertTarget?.())
        .then((info) => {
          if (info && typeof info === 'object') targetRef.current = info;
        })
        .catch(() => {});
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
                } — скачайте в «Настройки → Диктовка → Модель распознавания».`,
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
        streamIntervalMs: liveDraftRef.current.enabled ? 2500 : 0,
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
        onLevel: (v) => {
          setLevel(v);
          // Авто-стоп по тишине. Считаем только пока идёт запись и только в
          // переключателе; на паузе тишина — это норма, а не конец диктовки.
          const watch = silenceRef.current;
          if (!watch || !recRef.current || pausedAt.current) return;
          if (!watch.feed(v, Date.now())) return;
          silenceRef.current = null;
          diag.info('stt', 'Запись остановлена по тишине', { idleMs: AUTO_STOP_IDLE_MS });
          // Молчаливая остановка выглядела бы как сбой посреди фразы.
          pushToast({
            title: 'Запись остановлена',
            description: autoStopNotice(AUTO_STOP_IDLE_MS),
            ttl: 7000,
          });
          Promise.resolve(stopRef.current?.()).catch(() => {});
        },
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
        onEnd: async ({ text, ms, spoken, mode, parts, timeline, model }) => {
          recRef.current = null;
          setState('processing');
          setLevel(0);
          // Текст вставляем сразу: искусственная пауза «как в видео» только
          // задерживала вставку (диктовка должна появляться в окне мгновенно).
          // Исключение — включённая вторая стадия чистки моделью: тогда ждём её.
          const item = await finish(text, {
            sttMs: ms,
            spokenSeconds: spoken || 0,
            sttMeta: { mode, parts, timeline, model },
          });
          if (opts.onResult) opts.onResult(item);
        },
      });
      recRef.current = recognizer;
      setPaused(false);
      // Пока человек говорит, модель должна быть в памяти. В main прогрев уже
      // стартует по показу плашки, но плашку можно выключить в настройках —
      // тогда прогрева не было бы вовсе, и первая фраза платила бы за загрузку
      // весов. Повторный прогрев в main дешёвый: сервер тот же.
      if (settingsRef.current.keepModelLoaded !== false) {
        Promise.resolve(
          window.zspeakly?.native?.modelsWarm?.({ model: settingsRef.current.whisperModel }),
        ).catch(() => {});
      }
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
    silenceRef.current = null;
    const rec = recRef.current;
    // Отсюда и до готового текста — то время, которое человек реально ждёт.
    // Отчёт о скорости раньше судил только счёт движка и потому мог говорить
    // «укладывается», пока ожидание было дольше пяти секунд.
    if (rec) stopAtRef.current = Date.now();
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

  // stop объявлен ниже обработчика уровня, а нужен ему в момент тишины:
  // ссылка, а не прямой вызов
  useEffect(() => {
    stopRef.current = stop;
  }, [stop]);

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
        description:
          'Локальная модель для инструкций не отвечает: запустите Ollama на этом компьютере и нажмите «Проверить соединение» в «Настройки → Диктовка → Модель для инструкций».',
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
          description:
            'Текст очищен офлайн-правилами. Локальная модель инструкций молчит: «Настройки → Диктовка → Модель для инструкций».',
          tone: 'warn',
          ttl: 9000,
        });
        setState('idle');
        return;
      }
      const item = await finish(answer, { insert: false, spoken: false });
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
   * Командный режим: выделил текст — сказал, что с ним сделать.
   *
   * Выделение забираем сразу при нажатии: пока идёт запись, человек может
   * переключить окно или кликнуть по плашке, и выделения уже не будет.
   * Если выделения нет — говорим об этом до записи, а не после: незачем
   * заставлять человека говорить в пустоту.
   */
  const startCommand = useCallback(async () => {
    if (recRef.current) {
      stop();
      return;
    }
    let selection = '';
    try {
      selection = String((await readSelectionText()) || '').trim();
    } catch {
      selection = '';
    }
    if (!selection) {
      pushToast({
        title: COMMAND_ERRORS['no-selection'].title,
        description: COMMAND_ERRORS['no-selection'].message,
        tone: 'warn',
        ttl: 9000,
      });
      return;
    }
    commandRef.current = selection;
    start({ mode: 'toggle', command: true });
  }, [start, stop, pushToast]);

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
    // снятие с паузы — не конец диктовки: отсчёт тишины начинается заново
    silenceRef.current?.reset(Date.now());
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
          hint: 'Проверьте модель в «Настройки → Диктовка → Модель распознавания» и сохраните отчёт из «Настройки → Диагностика → Отправка отчётов».',
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
        // командный режим: сказанное применится к выделению, а не вставится
        if (payload.command) startCommand();
        // «диктовка с учётом экрана» на своём сочетании тоже переключатель
        else if (payload.screenAware && !recRef.current) start({ mode: 'toggle', screenAware: true });
        else toggle();
      }
      // «Агент» по двойному нажатию: начатая диктовка отменяется, а не
      // распознаётся — из неё всё равно вышел бы обрывок в полслова
      if (payload?.type === 'cancel') cancel();
      if (payload?.type === 'agent') askAgent();
    });
    return off;
  }, [start, stop, toggle, cancel, askAgent, startCommand]);

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
      // Имя файла модели человеку ничего не говорит, а «модель small-q5_1»
      // ещё и звучит как внутренность. Говорим размер — он объясняет, чего
      // ждём: 60 МБ или полгигабайта.
      const tier = p.id && p.id !== 'engine' ? tierForModel(p.id) : null;
      const what = p.id === 'engine' ? 'движок распознавания' : tier ? `модель, ${tier.size}` : 'модель распознавания';
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
      // main уже сохранил выбор сам; окну остаётся показать его. Запись того
      // же значения обратно ничего не закрепляет: main ставит «выбрано
      // вручную» только когда модель действительно поменялась.
      updateSettings?.({ whisperModel: p.to });
      const secs = Number(p.seconds || 0);
      const label = tierForModel(p.to).label.toLowerCase();
      // Три повода переключить модель: после долгого прохода (замер), сразу
      // при запуске (железо) и вверх — когда текст на самой лёгкой модели
      // путался, а машина тянет режим точнее.
      if (p.reason === 'quality') {
        pushToast({
          title: `Режим распознавания «${label}» — текст точнее`,
          description:
            p.why ||
            'Вы стояли на самом лёгком режиме, а он путает слова. Поднял на ступень выше: скорость та же, текст чище. Вернуть: «Настройки → Диктовка → Модель распознавания».',
          tone: 'success',
          ttl: 12000,
        });
        return;
      }
      const byHardware = p.reason === 'hardware' || !p.from || !Number(p.ms || 0);
      pushToast({
        title: byHardware
          ? `Режим распознавания «${label}» — под этот компьютер`
          : `Режим распознавания: «${label}»`,
        description: byHardware
          ? p.why ||
            'Взял режим, который успевает за вашей речью. Поменять можно в «Настройки → Диктовка → Модель распознавания».'
          : `Прошлый режим распознавал ${secs ? `${secs} с речи` : 'короткую фразу'} за ${(
              Number(p.ms || 0) / 1000
            ).toFixed(1)} с — долго. Переключил сам, качество текста для диктовки то же. Вернуть: «Настройки → Диктовка → Модель распознавания».`,
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
      // командный режим: плашка обязана сказать, что слушает команду, а не
      // диктовку, — иначе человек ждёт вставки вместо правки выделения
      command: Boolean(sessionOpts.current.command),
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
      // «Файл в текст»: задание и отмена — состояние живёт здесь, чтобы кнопка
      // на главной и строка прогресса показывали одно и то же
      fileJob,
      transcribeFile,
      cancelFile,
      clearError: () => setError(null),
      setHudOpen,
      formatK,
      askAgent,
    }),
    [
      state, draft, level, error, last, mode, elapsed, hudOpen, paused, processingMs, sttProgress,
      hudAllowed, hudNativeOn, engine, micWarmState, start, stop, toggle, pause, resume, cancelProcessing, finish, askAgent,
      fileJob, transcribeFile, cancelFile,
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
