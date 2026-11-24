import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Loader2, Mic, Pause, Pencil, Play, RotateCw, Search, Square, Trash2, X } from 'lucide-react';
import { useAppData } from '../state/AppDataProvider.jsx';
import { useDictation } from '../state/DictationProvider.jsx';
import { clipboardCopyError, writeClipboard } from '../lib/clipboard.js';
import { typeOut } from '../lib/feedback.js';
import { useToast } from '../state/ToastProvider.jsx';
import { navigate } from '../lib/router.js';
import { engineName, hasNativeStt, hasWebSpeech } from '../lib/recognition/engine.js';
import { VOICE_COMMAND_TIP } from '../lib/voiceCommands.js';
import { AUDIO_ACCEPT, progressLabel } from '../lib/recognition/audioFile.js';
import { keysLabel, timeHM, truncate, dayLabel, formatSeconds, formatK } from '../lib/utils.js';
import { APP, WHY_BETTER } from '../lib/config.js';
import { diffWords, hasRawText } from '../lib/historyRaw.js';
import Icon from '../components/ui/Icon.jsx';
import EditDictationModal from '../components/modals/EditDictationModal.jsx';
import { Button, SearchInput } from '../components/ui/Controls.jsx';

function HeroStat({ value, unit, label }) {
  return (
    <div className="hero-stat">
      <div className="hero-stat__label">{label}</div>
      <div className="hero-stat__value">
        <span className="hero-stat__number">{value}</span>
        <span className="hero-stat__unit">{unit}</span>
      </div>
    </div>
  );
}

/**
 * «Как считалось»: одной строкой то, что приложение сделало со звуком и как
 * его считало. Нужна для разбора «почему распозналось плохо» — по числам видно,
 * был ли микрофон тихим, сжимались ли паузы и шёл ли честный проход.
 */
function howItRan(item) {
  const bits = [];
  if (item.sttSecondPass) bits.push('второй проход (перебор вариантов)');
  else if (item.sttThorough) bits.push('честный проход сразу');
  if (item.sttGainDb) bits.push(`+${item.sttGainDb} дБ громкости`);
  if (item.sttPausesMs) bits.push(`паузы сжаты на ${(item.sttPausesMs / 1000).toFixed(1).replace('.', ',')} с`);
  if (item.sttModel) bits.push(item.sttModel.replace(/^ggml-/, '').replace(/\.bin$/, ''));
  return bits.join(' · ');
}

export default function HomePage() {
  const { dictations, voiceHotkeys, settings, deleteDictation, addDictation, updateDictation } = useAppData();
  const {
    state, draft, start, stop, last, elapsed, paused, pause, resume, processingMs, sttProgress,
    cancelProcessing, fileJob, transcribeFile, cancelFile, retryLast, retrying, agentPending,
  } = useDictation();
  // выбор файла: скрытый input — единственный способ открыть системный
  // диалог без нативного окна и новых разрешений
  const fileInputRef = useRef(null);
  const { push } = useToast();
  useEffect(() => {
    if (state !== 'listening') {
      setTarget(null);
      return undefined;
    }
    let alive = true;
    const native = typeof window !== 'undefined' ? window.zspeakly?.native : null;
    Promise.resolve(native?.insertTarget?.())
      .then((t) => {
        if (alive && t && typeof t === 'object') setTarget(t);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [state]);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [hoverId, setHoverId] = useState(null);
  const [snippet, setSnippet] = useState(null);
  // Слова, которые приложение изменило после распознавания: считаем один раз
  // на открытую запись, а не на каждый рендер.
  const changedWords = useMemo(
    () =>
      snippet && hasRawText(snippet)
        ? diffWords(snippet.rawText, snippet.text)
            .filter((part) => part.changed)
            .map((part) => part.text.trim())
            .filter(Boolean)
        : [],
    [snippet],
  );
  const [editing, setEditing] = useState(null);
  // Готовность диктовки: «Всё готово» не должно быть обещанием на пустой
  // установке без модели whisper. В браузере опираемся на Web Speech.
  const [readiness, setReadiness] = useState(null); // null | 'ready' | 'no-model'
  // Куда попадёт текст: наше поле (диктуем внутрь приложения) или другое окно.
  // Человек видит это ДО вставки, а не догадывается по результату.
  const [target, setTarget] = useState(null);
  // эффект печати: постепенно проявляем свежий результат
  const [typed, setTyped] = useState('');
  const [typedId, setTypedId] = useState(null);

  useEffect(() => {
    if (!last || settings.typingEffect !== true) {
      setTypedId(null);
      return undefined;
    }
    const controller = { aborted: false };
    setTypedId(last.id);
    setTyped('');
    typeOut(last.text, (partial) => setTyped(partial), { signal: controller });
    return () => {
      controller.aborted = true;
    };
  }, [last?.id, settings.typingEffect]);

  // источник правды — строка-акселератор из настроек («Control+Alt+Space»);
  // массив dictationKeys может быть устаревшим после смены сочетания
  const dictationKey =
    (settings.dictationKey
      ? settings.dictationKey
          .split('+')
          .map((k) => ({ Control: 'Ctrl', Command: 'Cmd', Super: 'Win' })[k] || k)
      : null) ||
    settings.dictationKeys ||
    voiceHotkeys.find((h) => h.id === 'dictation')?.keys ||
    ['Ctrl', 'Alt', 'Space'];

  // Ctrl+Shift+V открывает панель буфера (см. registerShortcuts в main-процессе)
  const clipboardKey = ['Ctrl', 'Shift', 'V'];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return dictations;
    return dictations.filter((d) => d.text.toLowerCase().includes(q));
  }, [dictations, query]);

  const visible = showAll ? filtered : filtered.slice(0, 6);
  const listening = state === 'listening';

  const totalWords = useMemo(() => dictations.reduce((sum, d) => sum + (d.words || 0), 0), [dictations]);
  const totalSeconds = useMemo(
    () => dictations.reduce((sum, d) => sum + (d.durationMs || 0), 0) / 1000,
    [dictations],
  );

  const copyText = async (text) => {
    try {
      await writeClipboard(text);
      push({ title: 'Скопировано в буфер', description: truncate(text, 64), tone: 'success' });
    } catch (err) {
      push(clipboardCopyError(err));
    }
  };

  // Esc закрывает просмотр расшифровки: остальные окна так умеют, а эта
  // панель раньше закрывалась только щелчком мимо или крестиком.
  useEffect(() => {
    if (!snippet) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setSnippet(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [snippet]);

  useEffect(() => {
    const bridge = window.zspeakly?.native;
    if (!bridge?.sttStatus) {
      const hasWeb = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
      setReadiness(hasWeb ? 'ready' : 'no-model');
      return undefined;
    }
    let alive = true;
    bridge
      .sttStatus(settings.whisperModel)
      .then((res) => {
        if (alive) setReadiness(res?.available ? 'ready' : 'no-model');
      })
      .catch(() => {
        if (alive) setReadiness('no-model');
      });
    return () => {
      alive = false;
    };
  }, [settings.whisperModel]);

  return (
    <div className="page page--home scroll-area">
      <header className="hero">
        <p className="hero__hello">
          {settings.userName ? `Привет, ${settings.userName}. ` : ''}
          {state === 'listening'
            ? 'Записываю…'
            : readiness === 'no-model'
              ? 'Модель распознавания ещё не подключена — диктовка не заработает, пока её нет.'
              : 'Всё готово к диктовке.'}
          {readiness === 'no-model' && state !== 'listening' ? (
            <>
              {' '}
              <button
                type="button"
                className="link-btn"
                onClick={() => navigate('settings', { section: 'dictation' })}
              >
                Выбрать модель
              </button>
            </>
          ) : null}
        </p>
        <h1 className="hero__title">
          Не печатай,
          <br />
          просто <span className="hero__badge">ZSpeakly</span>.
        </h1>
        {/* Превью в браузере: диктовка идёт через Web Speech и без интернета
            просто молчит. Раньше человек нажимал микрофон, «слушал» тишину и
            решал, что приложение сломано. Говорим об этом сразу. */}
        {!hasNativeStt() ? (
          <p className="hero__note" role="note">
            {hasWebSpeech
              ? 'Это окно в браузере: распознаёт системный движок, ему нужен интернет. Офлайн-диктовка работает в установленном приложении ZSpeakly.'
              : 'Здесь нет движка распознавания: офлайн-диктовка работает в установленном приложении ZSpeakly.'}
          </p>
        ) : null}
        <p className="hero__sub">
          Для диктовки — <kbd className="inline-key">{keysLabel(dictationKey)}</kbd>. Панель буфера
          обмена открывается по{' '}
          <kbd className="inline-key">{keysLabel(clipboardKey)}</kbd>, настройки — по{' '}
          <kbd className="inline-key">Ctrl + ,</kbd>.
        </p>
        {/* Голосовая пунктуация: о ней нельзя догадаться, а без неё человек
            диктует «запятая» словами и правит текст руками. */}
        {/* Чем мы отличаемся от встроенной диктовки — одной строкой и только в
            приложении: в браузерном превью распознавание идёт через системный
            движок, и обещание «офлайн» там было бы ложью. */}
        {hasNativeStt() ? (
          <p className="hero__why" title={WHY_BETTER.more}>
            {WHY_BETTER.items.map((item) => (
              <span key={item} className="hero__why-item">
                {item}
              </span>
            ))}
          </p>
        ) : null}

        <p className="hero__hint">{VOICE_COMMAND_TIP}</p>

        <div className={`hero__stats ${dictations.length ? '' : 'hero__stats--empty'}`}>
          {dictations.length ? (
            <>
              <HeroStat value={formatK(totalWords)} unit="" label="слов в истории" />
              <HeroStat value={Math.round(totalSeconds / 60)} unit="мин" label="речи продиктовано" />
            </>
          ) : null}
          <button
            type="button"
            className={`hero__mic ${listening ? 'is-recording' : ''}`}
            onClick={() => (listening ? stop() : start({ mode: 'hold' }))}
          >
            {listening ? <Square size={13} fill="currentColor" /> : <Mic size={15} />}
            <span>
              {listening
                ? `${paused ? 'Пауза' : 'Слушаю…'} ${(elapsed / 1000).toFixed(1)} с`
                : 'Начать диктовку'}
            </span>
          </button>
          {/* Пауза: раньше её не было вообще — можно было только остановить
              запись целиком и начать заново */}
          {listening ? (
            <button
              type="button"
              className="hero__pause"
              onClick={() => (paused ? resume() : pause())}
              title={paused ? 'Продолжить запись' : 'Приостановить запись'}
            >
              {paused ? <Play size={12} fill="currentColor" /> : <Pause size={12} fill="currentColor" />}
              <span>{paused ? 'Продолжить' : 'Пауза'}</span>
            </button>
          ) : null}
        </div>

        {/* «Файл в текст»: диктовка и расшифровка записи — разные задачи.
            Кнопка стоит рядом с микрофоном, но не спорит с ним: она вторичная. */}
        <p className="hero__file">
          <button
            type="button"
            className="link-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={Boolean(fileJob)}
          >
            Расшифровать файл
          </button>
          <span className="hero__file-note">
            запись из диктофона или встречи (WAV, MP3, M4A) — текст попадёт в «Недавние»,
            в чужое окно ничего не вставится
          </span>
          <input
            ref={fileInputRef}
            type="file"
            accept={AUDIO_ACCEPT}
            hidden
            aria-label="Файл для расшифровки"
            onChange={(e) => {
              const chosen = e.target.files?.[0];
              // input обнуляем сразу: иначе повторный выбор того же файла не
              // вызовет onChange, и кнопка будет выглядеть сломанной
              e.target.value = '';
              if (chosen) transcribeFile(chosen);
            }}
          />
        </p>

        {fileJob ? (
          <div className="live-draft live-draft--processing" role="status">
            <div className="live-draft__head">
              <span className="dot-live" />
              {fileJob.phase === 'decode'
                ? 'Читаю файл…'
                : `${progressLabel(fileJob.done, fileJob.total)} · ${fileJob.name}`}
            </div>
            <p className="live-draft__text">
              {fileJob.preview || (
                <span className="muted">
                  Звук разбирается — первые слова появятся через несколько секунд.
                </span>
              )}
            </p>
            <div className="live-draft__actions">
              <button type="button" className="link-btn" onClick={cancelFile}>
                ОТМЕНИТЬ
              </button>
            </div>
          </div>
        ) : null}

        {state === 'processing' ? (
          <div className="live-draft live-draft--processing">
            <div className="live-draft__head">
              <span className="dot-live" />
              {agentPending ? 'Агент ждёт ответ модели…' : `Транскрипция… ${(processingMs / 1000).toFixed(1)} с`}
              {!agentPending && sttProgress ? ` · фрагмент ${sttProgress.done} из ${sttProgress.total}` : ''}
            </div>
            <p className="live-draft__text">
              {agentPending
                ? <span className="muted">Ответ появится в истории и не вставится в чужое окно.</span>
                : draft || <span className="muted">Движок распознаёт запись — текст появится сразу после.</span>}
            </p>
            <div className="live-draft__actions">
              <button type="button" className="link-btn" onClick={cancelProcessing}>
                ОТМЕНИТЬ
              </button>
              {!agentPending && processingMs > 15000 ? (
                <span className="live-draft__hint">
                  Долго? В «Настройки → Диктовка → Модель распознавания» есть режим «Быстро» — он
                  считает примерно вдвое быстрее.
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {listening ? (
          <div className="live-draft">
            <div className="live-draft__head">
              <span className="dot-live" />
              {paused ? 'Пауза' : 'Живая диктовка'}
            </div>
            <p className="live-draft__text">
              {draft || (
                <span className="muted">
                  {paused ? 'Запись на паузе — нажмите «Продолжить».' : 'Говорите — текст появится здесь…'}
                </span>
              )}
            </p>
            <div className="live-draft__hint">
              {paused
                ? 'Уже сказанное сохранено — продолжите, когда будете готовы.'
                : target?.own
                  ? 'Вставим в поле этого приложения — туда, где стоит курсор.'
                  : target?.title
                    ? `Вставим в «${target.title}».`
                    : 'Вставим туда, где стоит курсор.'}
            </div>
          </div>
        ) : null}

        {!listening && last ? (
          <div className="last-result">
            {/* «Эффект печати»: текст проявляется по словам, как в демонстрации */}
            <Icon name="check" size={13} />
            <span className="last-result__text">{truncate(last.id === typedId ? typed : last.text, 96)}</span>
            <span className="last-result__meta">{formatSeconds(last.durationMs)}</span>
            {/* Ошибку видно сразу после вставки: последняя запись ещё в памяти,
                поэтому её можно прогнать честным проходом, не повторяя вслух.
                Текст меняется только если точный проход услышал больше. */}
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              onClick={() => retryLast()}
              disabled={retrying}
              title="Переспросить точно: прогнать последнюю запись честным проходом"
              aria-label="Переспросить точно"
            >
              {retrying ? <Loader2 size={12} className="spin" /> : <RotateCw size={12} />}
            </button>
            <button type="button" className="icon-btn icon-btn--sm" onClick={() => copyText(last.text)}>
              <Copy size={12} />
            </button>
          </div>
        ) : null}
      </header>

      <section className="recent">
        <div className="section-head">
          <h2 className="section-head__title">Недавние</h2>
          <div className="section-head__actions">
            {/* Поле поиска по пустой истории — декорация: искать нечего. */}
            {dictations.length ? (
              <SearchInput
                value={query}
                onChange={setQuery}
                placeholder="Поиск по расшифровкам"
                className="recent__search"
                icon={<Search size={12} />}
              />
            ) : null}
            {/* Кнопка есть только когда есть что показывать: неактивная
                «ПОКАЗАТЬ ВСЁ» выглядела как сломанная — нажимаешь, ничего. */}
            {filtered.length > 6 ? (
              <button type="button" className="link-btn" onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'СВЕРНУТЬ' : 'ПОКАЗАТЬ ВСЁ'}
              </button>
            ) : null}
          </div>
        </div>

        <div className="recent__list">
          {visible.length === 0 ? (
            <div className="recent__empty">
              {query ? `Для «${query}» результатов не найдено` : 'Пока нет расшифровок — начните диктовку или расшифруйте файл'}
            </div>
          ) : null}
          {visible.map((item) => (
            <div
              key={item.id}
              className={`recent__row ${hoverId === item.id ? 'is-hover' : ''}`}
              onMouseEnter={() => setHoverId(item.id)}
              onMouseLeave={() => setHoverId(null)}
              onClick={() => setSnippet(item)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setSnippet(item);
              }}
            >
              <span className="recent__time">{timeHM(item.createdAt)}</span>
              {/* Откуда текст: из файла, из команды голосом или из диктовки.
                  Без пометки человек не понимает, почему запись появилась сама. */}
              {item.source === 'file' || item.source === 'command' || item.source === 'agent' ? (
                <span
                  className="recent__tag"
                  title={
                    item.source === 'file'
                      ? item.fileName || 'Расшифровка файла'
                      : item.source === 'agent' ? 'Ответ агента' : `Команда: ${item.command || ''}`
                  }
                >
                  {item.source === 'file' ? 'файл' : item.source === 'agent' ? 'агент' : 'команда'}
                </span>
              ) : null}
              <span className="recent__text">{truncate(item.text, 108)}</span>
              {/* Вставку убрали командой «отмени»: без пометки запись в
                  истории выглядит так, будто текст остался в чужом окне. */}
              {item.undone ? (
                <span
                  className="recent__tag"
                  title="Эту вставку убрали из окна командой «отмени» — текст остался здесь"
                >
                  убрано
                </span>
              ) : null}
              {/* Приложение правило текст после распознавания. Раньше это было
                  невидимо: человек не понимал, движок ошибся или приложение. */}
              {hasRawText(item) ? (
                <span
                  className="recent__tag recent__tag--edited"
                  title="Приложение изменило текст после распознавания — откройте запись, чтобы увидеть как"
                >
                  правлено
                </span>
              ) : null}
              {/* Сколько заняло распознавание: видно, что движок работал, и
                  сразу понятно, если на этой машине он медленный. */}
              {item.sttMs ? (
                <span
                  className="recent__speed"
                  title={`Распознано за ${(item.sttMs / 1000).toFixed(2)} с`}
                >
                  {(item.sttMs / 1000).toFixed(1).replace('.', ',')} с
                </span>
              ) : null}
              {hoverId === item.id ? (
                <button
                  type="button"
                  className="icon-btn icon-btn--sm recent__copy"
                  onClick={(e) => {
                    e.stopPropagation();
                    copyText(item.text);
                  }}
                  aria-label="Скопировать"
                >
                  <Copy size={12} />
                </button>
              ) : null}
            </div>
          ))}
        </div>

        <div className="recent__footer">
          <span className="recent__footer-text">
            Версия {APP.version}
            {dictations.length ? ` · ${totalWords.toLocaleString('ru-RU')} слов за всё время` : ''}
          </span>
          <button
            type="button"
            className="link-btn"
            onClick={async () => {
              const bridge = window.zspeakly?.native;
              if (!bridge?.checkUpdates) {
                navigate('settings', { section: 'app' });
                return;
              }
              // Сбой сети или самого обновлятора раньше проходил молча:
              // человек нажимал и не получал ничего. Теперь — честный тост.
              let res = null;
              try {
                res = await bridge.checkUpdates();
              } catch (err) {
                push({ title: 'Не удалось проверить обновления', description: String(err?.message || err), tone: 'warn' });
                return;
              }
              if (res?.status === 'available') {
                push({ title: `Доступна ${res.version}`, description: 'Обновление скачивается в «Настройки → Приложение → Версия и обновления» — там же кнопка «Скачать».', tone: 'success' });
              } else if (res?.status === 'latest') {
                push({ title: 'Обновлений нет', description: `Установлена ${APP.version}.`, tone: 'success' });
              } else if (res?.status === 'error') {
                push({ title: 'Не удалось проверить обновления', description: res.reason || 'нет связи с GitHub', tone: 'warn' });
              } else if (res?.status === 'unavailable') {
                push({ title: 'Автообновление недоступно', description: res.reason, tone: 'warn' });
              } else {
                push({ title: 'Проверка не ответила', description: 'Обновлятор молчит — попробуйте позже.', tone: 'warn' });
              }
            }}
          >
            Проверить обновления
          </button>
        </div>
      </section>

      {snippet ? (
        <div className="snippet-overlay" onMouseDown={() => setSnippet(null)}>
          <div className="snippet" onMouseDown={(e) => e.stopPropagation()}>
            <div className="snippet__head">
              <div>
                <div className="snippet__time">
                  {dayLabel(snippet.createdAt)}, {timeHM(snippet.createdAt)}
                </div>
                <div className="snippet__meta">
                  {snippet.words} слов · {formatSeconds(snippet.durationMs)}
                  {howItRan(snippet) ? ` · ${howItRan(snippet)}` : ''}
                </div>
              </div>
              <button type="button" className="icon-btn icon-btn--sm" onClick={() => setSnippet(null)}>
                <X size={14} />
              </button>
            </div>
            <p className="snippet__text">{snippet.text}</p>
            {snippet.undone ? (
              <p className="snippet__note">
                Эту вставку убрали из окна командой «отмени». Здесь текст остался — можно
                скопировать или вставить снова.
              </p>
            ) : null}
            {hasRawText(snippet) ? (
              <div className="snippet__raw">
                <div className="snippet__raw-title">Как распозналось</div>
                <p className="snippet__raw-text">{snippet.rawText}</p>
                {/* Что именно изменило приложение: подсвечены слова, которых в
                    услышанном не было. Искать глазами разницу человек не должен. */}
                {changedWords.length ? (
                  <p className="snippet__diff">
                    <span className="snippet__diff-label">Приложение изменило:</span>{' '}
                    {changedWords.map((word, i) => (
                      <span key={`${word}-${i}`} className="snippet__diff-word">
                        {word}
                      </span>
                    ))}
                  </p>
                ) : null}
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    const restored = snippet.rawText;
                    if (updateDictation(snippet.id, { text: restored, rawText: undefined }) === false) {
                      push({ title: 'Текст превышает бюджет истории', description: 'Он не сохранён. Скопируйте его отсюда до закрытия уведомления или приложения.', recoverText: restored, recoverLabel: 'Несохранённый текст истории', tone: 'warn', ttl: 0 });
                      return;
                    }
                    setSnippet({ ...snippet, text: restored, rawText: undefined });
                    push({
                      title: 'Вернули как распозналось',
                      description: 'Дальше правьте руками — приложение этот текст больше не меняло.',
                      tone: 'success',
                      ttl: 7000,
                    });
                  }}
                >
                  Вернуть как распозналось
                </button>
              </div>
            ) : null}
            <div className="snippet__actions">
              <Button variant="ghost" size="sm" icon={<Copy size={13} />} onClick={() => copyText(snippet.text)}>
                Копировать
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={<Pencil size={12} />}
                onClick={() => {
                  setEditing(snippet);
                  setSnippet(null);
                }}
              >
                Исправить
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={<Trash2 size={12} />}
                onClick={() => {
                  // Промах мыши не должен стирать расшифровку навсегда:
                  // в тосте есть «Вернуть» на несколько секунд.
                  const removed = snippet;
                  deleteDictation(removed.id);
                  setSnippet(null);
                  push({
                    title: 'Запись удалена',
                    description: 'Можно вернуть — кнопка в этом сообщении.',
                    tone: 'warn',
                    ttl: 8000,
                    action: { label: 'Вернуть', onClick: () => addDictation(removed) },
                  });
                }}
              >
                Удалить
              </Button>
              <Button
                variant="white"
                size="sm"
                icon={<Mic size={13} />}
                onClick={() => {
                  setSnippet(null);
                  start({ mode: 'hold' });
                }}
              >
                Продиктовать ещё
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <EditDictationModal open={Boolean(editing)} item={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
