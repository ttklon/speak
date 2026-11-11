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
import { readClipboard, writeClipboard } from '../lib/clipboard.js';
import { useToast } from '../state/ToastProvider.jsx';
import { Toggle } from '../components/ui/Toggle.jsx';
import ConfirmDialog from '../components/ui/ConfirmDialog.jsx';
import { Button, EmptyState, SearchInput } from '../components/ui/Controls.jsx';
import { CLIPBOARD_TABS, DEFAULT_SETTINGS } from '../lib/config.js';
import { dayLabel, formatSeconds, kindLabel, timeHM, truncate } from '../lib/utils.js';
import { navigate } from '../lib/router.js';
import { startScreenRecording, isRecordingSupported } from '../lib/media/recorder.js';

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
  // очистка истории — только после подтверждения: один промах мыши не должен
  // стирать всё, что накопилось за день
  const [confirmClear, setConfirmClear] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [justCopied, setJustCopied] = useState(null);
  // какие пароли пользователь явно раскрыл в этой сессии
  const [revealed, setRevealed] = useState(() => new Set());
  const [recording, setRecording] = useState(null);
  const [recordMs, setRecordMs] = useState(0);
  const lastExternal = useRef(0);

  // Глобальные сочетания буфера (Shift+Ctrl+A и т.д.) регистрирует main-процесс,
  // но раньше он слал только навигацию. Теперь действие приезжает сюда, и
  // «Скриншот с придумкой» реально превращается в заметку с подписью.
  useEffect(() => {
    const bridge = window.zspeakly?.native;
    if (!bridge?.onClipboardAction) return undefined;
    return bridge.onClipboardAction((action) => {
      if (action === 'note') {
        const run = async () => {
          const res = await bridge?.screenshot?.();
          if (!res?.ok) {
            push({ title: 'Не удалось сделать скриншот', description: res?.reason, tone: 'warn' });
            return;
          }
          addClipboardItem({
            kind: 'note',
            title: 'Скриншот с заметкой',
            text: 'Снимок экрана. Допишите подпись — она сохранится вместе с картинкой.',
            image: res.image || '',
            source: 'Скриншот с придумкой',
            createdAt: Date.now(),
          });
          push({
            title: 'Заметка со скриншотом готова',
            description: 'Откройте её в буфере и допишите подпись.',
            tone: 'success',
          });
        };
        run();
        return;
      }
      runHotkey(action === 'screenshot' ? 'screenshot' : action);
    });
  }, [addClipboardItem, push]);

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
          const text = await readClipboard();
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

  /** Запись экрана: старт/стоп, постер в историю и файл в «Видео». */
  const toggleRecording = async () => {
    if (recording) {
      const result = await recording.stop();
      setRecording(null);
      if (!result?.blob?.size) {
        push({ title: 'Запись пустая', tone: 'warn' });
        return;
      }
      const item = {
        kind: 'file',
        text: `Запись экрана · ${formatSeconds(result.durationMs)} · ${result.sizeMb} МБ`,
        image: result.poster || '',
        source: 'Запись экрана — ZSpeakly',
        createdAt: Date.now(),
      };
      addClipboardItem(item);
      // сохраняем файл рядом, чтобы видео не потерялось
      const bridge = window.zspeakly?.native;
      if (bridge?.saveFile) {
        const buf = await result.blob.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        const saved = await bridge.saveFile({ name: `ZSpeakly-${Date.now()}.webm`, base64 });
        push({
          title: 'Запись сохранена',
          description: saved?.ok ? saved.path : 'Видео добавлено в буфер обмена',
          tone: 'success',
        });
      } else {
        const url = URL.createObjectURL(result.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ZSpeakly-${Date.now()}.webm`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        push({ title: 'Запись сохранена', description: 'Файл скачан в «Загрузки»', tone: 'success' });
      }
      return;
    }

    if (!isRecordingSupported()) {
      push({ title: 'Запись экрана недоступна', description: 'Нужен установленный ZSpeakly на Windows.', tone: 'warn' });
      return;
    }
    try {
      const rec = await startScreenRecording({ onTick: (ms) => setRecordMs(ms) });
      setRecordMs(0);
      setRecording(rec);
      push({ title: 'Запись пошла', description: 'Нажмите «Запись экрана» ещё раз, чтобы остановить.', tone: 'success' });
      // остановка из системного диалога тоже должна завершить запись
      rec.finished.then(() => setRecording((cur) => (cur === rec ? null : cur)));
    } catch (err) {
      push({
        title: 'Не удалось начать запись',
        description: err?.name === 'NotAllowedError' ? 'Выбор экрана отменён' : String(err?.message || err),
        tone: 'warn',
      });
    }
  };

  /** Скриншот: в Electron — реальный снимок экрана, в браузере — демо-картинка. */
  const runHotkey = async (id) => {
    if (id === 'panel') {
      navigate('clipboard');
      return;
    }
    if (id === 'record') {
      await toggleRecording();
      return;
    }
    const bridge = window.zspeakly?.native;
    if (bridge?.screenshot) {
      const res = await bridge.screenshot();
      push({
        title: res?.ok ? 'Скриншот сохранён' : 'Не удалось сделать скриншот',
        description: res?.ok ? `${res.width}×${res.height} · уже в буфере обмена` : res?.reason,
        tone: res?.ok ? 'success' : 'warn',
      });
      return;
    }
    // Браузер: рисуем снимок вкладки через canvas, чтобы превью тоже работало
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 640, 360);
    grad.addColorStop(0, '#1b1d22');
    grad.addColorStop(1, '#2b2f38');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    ctx.font = '600 20px Inter, sans-serif';
    ctx.fillText('Снимок экрана', 28, 44);
    ctx.fillStyle = 'rgba(255,255,255,.45)';
    ctx.font = '13px Inter, sans-serif';
    ctx.fillText(`${document.title || 'ZSpeakly'} · ${new Date().toLocaleTimeString('ru-RU')}`, 28, 68);
    addClipboardItem({
      kind: 'image',
      text: '',
      image: canvas.toDataURL('image/png'),
      source: 'Снимок экрана — ZSpeakly',
      createdAt: Date.now(),
    });
    push({ title: 'Скриншот сохранён', description: 'В установленной версии снимается весь экран.', tone: 'success' });
  };

  const copyItem = async (item) => {
    try {
      // нативный мост первым: в file:// браузерное API часто запрещено
      await writeClipboard(item.text || '', item.image);
      setJustCopied(item.id);
      setTimeout(() => setJustCopied(null), 1400);
      push({ title: 'Скопировано', description: truncate(item.text, 60), tone: 'success', ttl: 1800 });
    } catch {
      push({
        title: 'Не удалось скопировать',
        description: 'Выделите текст в карточке и нажмите Ctrl+C.',
        tone: 'warn',
      });
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
            <button
              key={h.id}
              type="button"
              className="clip-hotkey"
              onClick={() => runHotkey(h.id)}
              title={`${h.title} — ${h.keys.join(' + ')}`}
            >
              <span className="clip-hotkey__icon">
                <IconCmp size={13} />
              </span>
              <div className="clip-hotkey__body">
                <div className="clip-hotkey__title">
                {h.id === 'record' && recording ? `Остановить · ${formatSeconds(recordMs)}` : h.title}
              </div>
                <div className="clip-hotkey__keys">
                  {h.keys.map((k) => (
                    <span key={k} className="key" style={{ height: 16, minWidth: 16, fontSize: 8.5 }}>
                      {k}
                    </span>
                  ))}
                </div>
              </div>
            </button>
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
                  ) : item.kind === 'password' && settings.hidePasswords ? (
                    // «Скрывать пароли»: в сетке значение замаскировано, чтобы его
                    // не было видно при демонстрации экрана
                    <div className="clip-card__text clip-card__text--masked">
                      {'•'.repeat(Math.min(16, Math.max(6, String(item.text || '').length)))}
                    </div>
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
                      <div className="clip-list__text">
                        {item.kind === 'password' && settings.hidePasswords
                          ? '•'.repeat(Math.min(16, Math.max(6, String(item.text || '').length)))
                          : item.text || '[изображение]'}
                      </div>
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
                  ) : selected.kind === 'password' && settings.hidePasswords && !revealed.has(selected.id) ? (
                    // настройка «Скрывать пароли»: пока не нажали «Показать», значение замаскировано
                    <span className="clip-preview__masked">
                      {'•'.repeat(Math.min(24, Math.max(8, String(selected.text || '').length)))}
                      <button
                        type="button"
                        className="clip-preview__reveal"
                        onClick={() => setRevealed((prev) => new Set(prev).add(selected.id))}
                      >
                        Показать
                      </button>
                    </span>
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
          onClick={() => setConfirmClear(true)}
        >
          Очистить историю
        </button>
      </div>
      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={() => {
          clearClipboard();
          push({ title: 'История очищена', description: 'Закреплённые элементы остались.', tone: 'success' });
        }}
        title="Очистить историю буфера?"
        description={`Будут удалены все незакреплённые элементы (${clipboard.length - clipboard.filter((c) => c.pinned).length} шт.). Закреплённые останутся. Действие нельзя отменить.`}
        confirmLabel="Очистить"
      />
    </div>
  );
}
