import { useMemo, useState } from 'react';
import { Copy, Mic, Pencil, Search, Square, Trash2, X } from 'lucide-react';
import { useAppData } from '../state/AppDataProvider.jsx';
import { useDictation } from '../state/DictationProvider.jsx';
import { writeClipboard } from '../lib/clipboard.js';
import { useToast } from '../state/ToastProvider.jsx';
import { navigate } from '../lib/router.js';
import { keysLabel, timeHM, truncate, dayLabel, formatSeconds } from '../lib/utils.js';
import { APP } from '../lib/config.js';
import Icon from '../components/ui/Icon.jsx';
import EditDictationModal from '../components/modals/EditDictationModal.jsx';
import { Button, SearchInput } from '../components/ui/Controls.jsx';

const STAT_MINUTES = 144; // «144 мин» экономии — как в кадре видео

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
  const { dictations, voiceHotkeys, settings, deleteDictation } = useAppData();
  const { state, draft, start, stop, last, elapsed } = useDictation();
  const { push } = useToast();
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [hoverId, setHoverId] = useState(null);
  const [snippet, setSnippet] = useState(null);
  const [editing, setEditing] = useState(null);

  const dictationKey =
    settings.dictationKeys ||
    voiceHotkeys.find((h) => h.id === 'dictation')?.keys ||
    ['Ctrl', 'Alt', 'Space'];

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
        {settings.userName ? (
          <p className="hero__hello">
            Привет, {settings.userName}. {state === 'listening' ? 'Записываю…' : 'Всё готово к диктовке.'}
          </p>
        ) : null}
        <h1 className="hero__title">
          Не печатай,
          <br />
          просто <span className="hero__badge">ZSpeakly</span>.
        </h1>
        <p className="hero__sub">
          Удерживайте клавишу{' '}
          <kbd className="inline-key">{keysLabel(dictationKey.slice(-1))}</kbd> для диктовки. Дважды нажмите
          клавишу{' '}
          <kbd className="inline-key">{keysLabel(dictationKey.slice(0, 2))}</kbd>, чтобы открыть панель
          буфера обмена.
        </p>

        <div className="hero__stats">
          <HeroStat value={STAT_MINUTES} unit="мин" label="сэкономлено времени" />
          <HeroStat value="9.0" unit="к" label="количество слов" />
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
            <Icon name="check" size={13} />
            <span className="last-result__text">{truncate(last.text, 96)}</span>
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
              const res = await bridge.checkUpdates();
              if (res?.status === 'available') {
                push({ title: `Доступна ${res.version}`, description: 'Откройте «О программе», чтобы скачать.', tone: 'success' });
              } else if (res?.status === 'latest') {
                push({ title: 'Обновлений нет', description: `Установлена ${APP.version}.`, tone: 'success' });
              } else if (res?.status === 'unavailable' || res?.status === 'error') {
                push({ title: 'Автообновление недоступно', description: res.reason, tone: 'warn' });
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
                  deleteDictation(snippet.id);
                  setSnippet(null);
                  push({ title: 'Запись удалена', tone: 'warn' });
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
