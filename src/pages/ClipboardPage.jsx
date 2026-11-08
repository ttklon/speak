import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Clipboard as ClipboardIcon,
  Copy,
  Grid2X2,
  List,
  Lock,
  Pin,
  ScanLine,
  Search,
  Settings2,
  Trash2,
  Video,
} from 'lucide-react';
import { useAppData } from '../state/AppDataProvider.jsx';
import { useToast } from '../state/ToastProvider.jsx';
import { Toggle } from '../components/ui/Toggle.jsx';
import { Button, EmptyState, SearchInput } from '../components/ui/Controls.jsx';
import { CLIPBOARD_TABS, DEFAULT_SETTINGS } from '../lib/config.js';
import { dayLabel, kindLabel, timeHM, truncate } from '../lib/utils.js';
import { navigate } from '../lib/router.js';

const TABS = [{ id: 'all', label: 'Все' }, ...CLIPBOARD_TABS];

const HOTKEYS = [
  { id: 'screenshot', title: 'Скриншот', keys: ['Shift', 'Ctrl', 'A'], icon: ScanLine },
  { id: 'record', title: 'Запись экрана', keys: ['Shift', 'Ctrl', 'R'], icon: Video },
  { id: 'note', title: 'Скриншот с придумкой', keys: ['Shift', 'Ctrl', 'S'], icon: ClipboardIcon },
  { id: 'panel', title: 'Открыть панель', keys: ['Shift', 'Ctrl', 'V'], icon: List },
];

export default function ClipboardPage() {
  const {
    clipboard,
    settings,
    updateSettings,
    removeClipboardItem,
    clearClipboard,
    toggleClipboardPin,
    addClipboardItem,
  } = useAppData();
  const { push } = useToast();
  const [tab, setTab] = useState('all');
  const [view, setView] = useState('grid');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [justCopied, setJustCopied] = useState(null);
  const lastExternal = useRef(0);

  // Приём новых элементов из main-процесса Electron (нативный мониторинг)
  useEffect(() => {
    const onClip = (e) => {
      const item = e.detail;
      if (!item) return;
      lastExternal.current = Date.now();
      addClipboardItem(item);
    };
    window.addEventListener('zs:clipboard', onClip);
    return () => window.removeEventListener('zs:clipboard', onClip);
  }, [addClipboardItem]);

  // В браузере (preview) — перехват копирования внутри окна
  useEffect(() => {
    if (window.zspeakly?.isElectron) return undefined;
    if (!settings.clipboardMonitor) return undefined;
    const onCopy = () => {
      if (Date.now() - lastExternal.current < 300) return;
      setTimeout(async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (!text) return;
          addClipboardItem({
            kind: /^(https?:\/\/|www\.)/i.test(text.trim()) ? 'text' : 'text',
            text,
            source: 'Копирование в ZSpeakly',
            createdAt: Date.now(),
          });
        } catch {
          /* доступ к буферу закрыт — молча пропускаем */
        }
      }, 60);
    };
    document.addEventListener('copy', onCopy);
    return () => document.removeEventListener('copy', onCopy);
  }, [settings.clipboardMonitor, addClipboardItem]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return clipboard.filter((item) => {
      if (tab !== 'all') {
        if (tab === 'text' && !['text', 'password'].includes(item.kind)) return false;
        if (tab === 'format' && item.kind !== 'format') return false;
        if (tab === 'image' && item.kind !== 'image') return false;
        if (tab === 'file' && item.kind !== 'file') return false;
        if (tab === 'password' && item.kind !== 'password') return false;
      }
      if (!q) return true;
      return `${item.text || ''} ${item.source || ''}`.toLowerCase().includes(q);
    });
  }, [clipboard, tab, query]);

  const grouped = useMemo(() => {
    const map = new Map();
    filtered.forEach((item) => {
      const key = dayLabel(item.createdAt);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    });
    return Array.from(map.entries());
  }, [filtered]);

  const selected = useMemo(
    () => filtered.find((i) => i.id === selectedId) || filtered[0],
    [filtered, selectedId],
  );

  const copyItem = async (item) => {
    try {
      await navigator.clipboard.writeText(item.text || '');
      setJustCopied(item.id);
      setTimeout(() => setJustCopied(null), 1400);
      push({ title: 'Скопировано', description: truncate(item.text, 60), tone: 'success', ttl: 1800 });
      if (window.zspeakly?.native?.writeClipboard) {
        window.zspeakly.native.writeClipboard({ text: item.text, image: item.image });
      }
    } catch {
      push({ title: 'Буфер обмена недоступен', tone: 'warn' });
    }
  };

  const copyPaste = async (item) => {
    await copyItem(item);
    window.zspeakly?.native?.pasteToActive?.();
  };

  return (
    <div className="page page--clipboard">
      <div className="clip-head">
        <div>
          <h1 className="page__title">Буфер обмена</h1>
          <p className="page__sub">Всё, что вы захватываете и копируете, — в одном месте.</p>
        </div>
        <div className="clip-head__toggle-wrap">
          <span className="clip-head__state">{settings.clipboardMonitor ? 'Включено' : 'Выключено'}</span>
          <Toggle
            checked={settings.clipboardMonitor}
            onChange={(v) => {
              updateSettings({ clipboardMonitor: v });
              push({
                title: v ? 'Мониторинг включён' : 'Мониторинг выключен',
                description: v ? 'Новые копирования попадут в историю.' : 'История больше не пополняется.',
              });
            }}
          />
          <button
            type="button"
            className="icon-btn"
            onClick={() => navigate('settings', { section: 'features', from: 'clipboard' })}
            aria-label="Настройки буфера"
          >
            <Settings2 size={14} />
          </button>
        </div>
      </div>

      <div className="clip-hotkeys">
        {HOTKEYS.map((h) => {
          const IconCmp = h.icon;
          return (
            <div key={h.id} className="clip-hotkey">
              <span className="clip-hotkey__icon">
                <IconCmp size={13} />
              </span>
              <div className="clip-hotkey__body">
                <div className="clip-hotkey__title">{h.title}</div>
                <div className="clip-hotkey__keys">
                  {h.keys.map((k) => (
                    <span key={k} className="key" style={{ height: 16, minWidth: 16, fontSize: 8.5 }}>
                      {k}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="clip-toolbar">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Поиск по истории буфера"
          icon={<Search size={12} />}
        />
        <div className="clip-toolbar__tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`btn btn--tab ${tab === t.id ? 'is-active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="clip-toolbar__view">
          <button
            type="button"
            className={`icon-btn ${view === 'grid' ? 'is-active-view' : ''}`}
            onClick={() => setView('grid')}
            aria-label="Сетка"
          >
            <Grid2X2 size={14} />
          </button>
          <button
            type="button"
            className={`icon-btn ${view === 'list' ? 'is-active-view' : ''}`}
            onClick={() => setView('list')}
            aria-label="Список"
          >
            <List size={14} />
          </button>
        </div>
      </div>

      <div className="clip-body">
        {filtered.length === 0 ? (
          <EmptyState
            icon={<ClipboardIcon size={22} />}
            title={query ? `Для «${query}» результатов не найдено` : 'История буфера пуста'}
            description={
              query
                ? 'Попробуйте другой запрос или переключите вкладку.'
                : 'Скопируйте любой текст — ZSpeakly сохранит его здесь, даже после перезапуска.'
            }
            compact
          />
        ) : view === 'grid' ? (
          <div className="scroll-area clip-scroll">
            <div className="clip-grid">
              {filtered.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`clip-card ${selected?.id === item.id ? 'is-selected' : ''} ${
                    item.pinned ? 'is-pinned' : ''
                  }`}
                  onClick={() => setSelectedId(item.id)}
                  onDoubleClick={() => copyPaste(item)}
                  title={item.text || item.source}
                >
                  {item.kind === 'image' && item.image ? (
                    <img className="clip-card__image" src={item.image} alt={item.source || 'Изображение'} />
                  ) : (
                    <div className="clip-card__text">{item.text}</div>
                  )}
                  <div className="clip-card__meta">
                    <span className="clip-card__kind">{kindLabel(item.kind)}</span>
                    <span className="clip-card__source">{item.source}</span>
                    <span className="clip-card__time">{timeHM(item.createdAt)}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="clip-list">
            <div className="clip-list__col scroll-area">
              {grouped.map(([day, items]) => (
                <div key={day}>
                  <div className="clip-list__day">{day}</div>
                  {items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`clip-list__item ${selected?.id === item.id ? 'is-selected' : ''}`}
                      onClick={() => setSelectedId(item.id)}
                      onDoubleClick={() => copyPaste(item)}
                    >
                      <div className="clip-list__text">{item.text || '[изображение]'}</div>
                      <div className="clip-list__source">
                        {item.source} · {timeHM(item.createdAt)}
                      </div>
                    </button>
                  ))}
                </div>
              ))}
            </div>
            {selected ? (
              <div className="clip-preview">
                <div className="clip-preview__head">
                  <span className="clip-card__kind">{kindLabel(selected.kind)}</span>
                  <span className="clip-preview__source">{selected.source}</span>
                  {selected.kind === 'password' ? <Lock size={11} style={{ opacity: 0.5 }} /> : null}
                  <button
                    type="button"
                    className={`icon-btn icon-btn--sm ${selected.pinned ? 'is-pinned-btn' : ''}`}
                    style={{ marginLeft: 'auto' }}
                    onClick={() => toggleClipboardPin(selected.id)}
                    aria-label="Закрепить"
                  >
                    <Pin size={11} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm icon-btn--danger"
                    onClick={() => {
                      removeClipboardItem(selected.id);
                      setSelectedId(null);
                    }}
                    aria-label="Удалить"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
                <div className="clip-preview__body">
                  {selected.kind === 'image' && selected.image ? (
                    <img className="clip-preview__img" src={selected.image} alt={selected.source} />
                  ) : (
                    selected.text
                  )}
                </div>
                <div className="clip-preview__actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Copy size={12} />}
                    onClick={() => copyItem(selected)}
                  >
                    Копировать как обычный текст
                  </Button>
                  <Button variant="white" size="sm" icon={<Check size={12} />} onClick={() => copyPaste(selected)}>
                    {justCopied === selected.id ? 'Скопировано' : 'Копировать'}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="clip-foot">
        <span className="clip-foot__count">
          {filtered.length} из {clipboard.length} элементов · хранить {settings.clipboardRetentionDays} дней ·
          лимит {settings.clipboardMaxItems.toLocaleString('ru-RU')}
        </span>
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            clearClipboard();
            push({ title: 'История очищена', description: 'Закреплённые элементы остались.', tone: 'success' });
          }}
        >
          Очистить историю
        </button>
      </div>
    </div>
  );
}
