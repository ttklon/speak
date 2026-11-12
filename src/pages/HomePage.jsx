import { useEffect, useMemo, useState } from 'react';
import { Copy, Mic, Pencil, Search, Square, Trash2, X } from 'lucide-react';
import { useAppData } from '../state/AppDataProvider.jsx';
import { useDictation } from '../state/DictationProvider.jsx';
import { writeClipboard } from '../lib/clipboard.js';
import { typeOut } from '../lib/feedback.js';
import { useToast } from '../state/ToastProvider.jsx';
import { navigate } from '../lib/router.js';
import { keysLabel, timeHM, truncate, dayLabel, formatSeconds, formatK } from '../lib/utils.js';
import { APP } from '../lib/config.js';
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

export default function HomePage() {
  const { dictations, voiceHotkeys, settings, deleteDictation, addDictation } = useAppData();
  const { state, draft, start, stop, last, elapsed } = useDictation();
  const { push } = useToast();
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [hoverId, setHoverId] = useState(null);
  const [snippet, setSnippet] = useState(null);
  const [editing, setEditing] = useState(null);
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
    } catch {
      push({ title: 'Не удалось скопировать', tone: 'warn' });
    }
  };

  return (
    <div className="page page--home scroll-area">
      <header className="hero">
        <p className="hero__hello">
          {settings.userName ? `Привет, ${settings.userName}. ` : ''}
          {state === 'listening' ? 'Записываю…' : 'Всё готово к диктовке.'}
        </p>
        <h1 className="hero__title">
          Не печатай,
          <br />
          просто <span className="hero__badge">ZSpeakly</span>.
        </h1>
        <p className="hero__sub">
          Для диктовки — <kbd className="inline-key">{keysLabel(dictationKey)}</kbd>. Панель буфера
          обмена открывается по{' '}
          <kbd className="inline-key">{keysLabel(clipboardKey)}</kbd>, настройки — по{' '}
          <kbd className="inline-key">Ctrl + ,</kbd>.
        </p>

        <div className="hero__stats">
          <HeroStat value={formatK(totalWords)} unit="" label="слов в истории" />
          <HeroStat value={Math.round(totalSeconds / 60)} unit="мин" label="речи продиктовано" />
          <button
            type="button"
            className={`hero__mic ${listening ? 'is-recording' : ''}`}
            onClick={() => (listening ? stop() : start({ mode: 'hold' }))}
          >
            {listening ? <Square size={13} fill="currentColor" /> : <Mic size={15} />}
            <span>{listening ? `Слушаю… ${(elapsed / 1000).toFixed(1)} с` : 'Начать диктовку'}</span>
          </button>
        </div>

        {listening || state === 'processing' ? (
          <div className="live-draft">
            <div className="live-draft__head">
              <span className="dot-live" />
              {state === 'processing' ? 'Транскрипция…' : 'Живая диктовка'}
            </div>
            <p className="live-draft__text">
              {draft || <span className="muted">Говорите — текст появится здесь…</span>}
            </p>
          </div>
        ) : null}

        {!listening && last ? (
          <div className="last-result">
            {/* «Эффект печати»: текст проявляется по словам, как в демонстрации */}
            <Icon name="check" size={13} />
            <span className="last-result__text">{truncate(last.id === typedId ? typed : last.text, 96)}</span>
            <span className="last-result__meta">{formatSeconds(last.durationMs)}</span>
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
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="Поиск по расшифровкам"
              className="recent__search"
              icon={<Search size={12} />}
            />
            <button
              type="button"
              className="link-btn"
              onClick={() => setShowAll((v) => !v)}
              disabled={filtered.length <= 6}
            >
              {showAll ? 'СВЕРНУТЬ' : 'ПОКАЗАТЬ ВСЁ'}
            </button>
          </div>
        </div>

        <div className="recent__list">
          {visible.length === 0 ? (
            <div className="recent__empty">
              {query ? `Для «${query}» результатов не найдено` : 'Пока нет расшифровок — начните диктовку'}
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
              <span className="recent__text">{truncate(item.text, 108)}</span>
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
            Версия {APP.version} · {totalWords.toLocaleString('ru-RU')} слов ·{' '}
            {Math.round(totalSeconds)} с речи
          </span>
          <button
            type="button"
            className="link-btn"
            onClick={async () => {
              const bridge = window.zspeakly?.native;
              if (!bridge?.checkUpdates) {
                navigate('settings', { section: 'about' });
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
                push({ title: `Доступна ${res.version}`, description: 'Откройте «О программе», чтобы скачать.', tone: 'success' });
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
                </div>
              </div>
              <button type="button" className="icon-btn icon-btn--sm" onClick={() => setSnippet(null)}>
                <X size={14} />
              </button>
            </div>
            <p className="snippet__text">{snippet.text}</p>
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
