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
  { id: 'note', title: 'Скриншот-заметка', keys: ['Shift', 'Ctrl', 'S'], icon: ClipboardIcon },
  { id: 'panel', title: 'Открыть панель', keys: ['Shift', 'Ctrl', 'V'], icon: List },
];

export default function ClipboardPage() {
  const {
    clipboard,
    settings,
    updateSettings,
    removeClipboardItem,
    updateClipboardItem,
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
  // подпись к «скриншоту с заметкой»: раньше текст предлагал её дописать,
  // но дописать было негде
  const [noteDraft, setNoteDraft] = useState('');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [justCopied, setJustCopied] = useState(null);
  // какие пароли пользователь явно раскрыл в этой сессии
  const [revealed, setRevealed] = useState(() => new Set());
  // расшифрованный текст пароля: держим в памяти только до перезагрузки окна
  const [decrypted, setDecrypted] = useState({});
  const [recording, setRecording] = useState(null);
  const [recordMs, setRecordMs] = useState(0);
  const lastExternal = useRef(0);

  // Глобальные сочетания буфера (Shift+Ctrl+A и т.д.) регистрирует main-процесс,
  // но раньше он слал только навигацию. Теперь действие приезжает сюда, и
  // «Скриншот-заметка» — снимок экрана, к которому человек дописывает подпись.
  useEffect(() => {
    const bridge = window.zspeakly?.native;
    if (!bridge?.onClipboardAction) return undefined;
    return bridge.onClipboardAction((action) => {
      if (action === 'note') {
        captureNote();
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
            kind: 'text',
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
        // заметка — это снимок экрана с подписью, поэтому она и в «Изображениях»
        if (tab === 'image' && !['image', 'note'].includes(item.kind)) return false;
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

  // В списке панель предпросмотра показывает первую запись, даже если ничего
  // не выбрано. Для сетки наоборот: панель действий появляется только после
  // явного выбора карточки — иначе она висела там всегда.
  const explicit = useMemo(
    () => (selectedId ? filtered.find((i) => i.id === selectedId) || null : null),
    [filtered, selectedId],
  );
  const selected = useMemo(() => explicit || filtered[0], [explicit, filtered]);

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
    // Браузерный диалог выбора экрана может висеть, ничего не сообщая:
    // сразу говорим, что от человека ждут выбора окна.
    if (!window.zspeakly?.native?.screenshot) {
      push({ title: 'Выберите окно или экран', description: 'В диалоге браузера отметьте, что записывать.', tone: 'success' });
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

  /**
   * Снимок экрана: в приложении — через main (весь экран), в браузере — через
   * getDisplayMedia (выбор окна/экрана). Возвращает null, если не получилось,
   * и сам показывает понятную причину.
   */
  const captureScreen = async () => {
    const bridge = window.zspeakly?.native;
    if (bridge?.screenshot) {
      const res = await bridge.screenshot();
      if (!res?.ok) {
        push({ title: 'Не удалось сделать скриншот', description: res?.reason, tone: 'warn' });
        return null;
      }
      return { image: res.image || '', width: res.width, height: res.height };
    }
    const media = navigator.mediaDevices;
    if (!media?.getDisplayMedia) {
      push({
        title: 'Снимок экрана недоступен',
        description: 'Браузер не даёт захват экрана. В приложении для Windows снимок делает главный процесс.',
        tone: 'warn',
      });
      return null;
    }
    let stream;
    try {
      stream = await media.getDisplayMedia({ video: { frameRate: 1 }, audio: false });
    } catch (err) {
      push({
        title: 'Снимок не сделан',
        description: err?.name === 'NotAllowedError' ? 'Выбор экрана отменён.' : String(err?.message || err),
        tone: 'warn',
      });
      return null;
    }
    try {
      const track = stream.getVideoTracks?.()[0];
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      // ждём первый настоящий кадр, иначе canvas остаётся пустым
      if (video.readyState < 2) {
        await new Promise((resolve) => {
          video.onloadeddata = resolve;
          setTimeout(resolve, 800);
        });
      }
      const width = video.videoWidth || track?.getSettings?.().width || 0;
      const height = video.videoHeight || track?.getSettings?.().height || 0;
      if (!width || !height) {
        push({ title: 'Снимок не сделан', description: 'Не удалось получить кадр с экрана.', tone: 'warn' });
        return null;
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(video, 0, 0, width, height);
      return { image: canvas.toDataURL('image/png'), width, height, label: track?.label || 'браузер' };
    } catch (err) {
      push({ title: 'Снимок не сделан', description: String(err?.message || err), tone: 'warn' });
      return null;
    } finally {
      stream.getTracks().forEach((t) => t.stop());
    }
  };

  useEffect(() => {
    setNoteDraft(selected?.kind === 'note' ? selected.text || '' : '');
  }, [selected?.id, selected?.kind]);

  /** Скриншот с заметкой: картинка + подпись, которую человек дописывает. */
  const captureNote = async () => {
    const res = await captureScreen();
    if (!res) return;
    addClipboardItem({
      kind: 'note',
      title: 'Скриншот с заметкой',
      text: '',
      image: res.image || '',
      source: 'Скриншот-заметка',
      createdAt: Date.now(),
    });
    push({
      title: 'Заметка со скриншотом готова',
      description: 'Откройте её в списке и допишите подпись.',
      tone: 'success',
    });
  };

  /** Действия плиток хоткеев буфера. */
  const runHotkey = async (id) => {
    if (id === 'panel') {
      // Раньше плитка просто переходила на эту же страницу: нажатие «ничего
      // не делало». Теперь ставим курсор в поиск — панель готова к работе.
      navigate('clipboard');
      setTimeout(() => {
        const input = document.querySelector('.clip-toolbar .search-input input, .clip-search input');
        if (input) input.focus();
      }, 80);
      push({ title: 'Панель буфера открыта', description: 'Поиск по истории — сразу в фокусе. Ctrl + K из любого экрана.', tone: 'success' });
      return;
    }
    if (id === 'record') {
      await toggleRecording();
      return;
    }
    if (id === 'note') {
      await captureNote();
      return;
    }
    const shot = await captureScreen();
    if (!shot) return;
    addClipboardItem({
      kind: 'image',
      text: '',
      image: shot.image,
      source: `Снимок экрана — ${shot.label || 'ZSpeakly'}`,
      createdAt: Date.now(),
    });
    push({ title: 'Скриншот сохранён', description: `${shot.width}×${shot.height} · в истории буфера`, tone: 'success' });
  };

  /**
   * Открытый текст записи: у пароля в профиле лежит только шифр, поэтому
   * значение спрашиваем у main (DPAPI). Возвращает null, если расшифровать
   * не удалось — тогда показывать нечего и врать про «зашифровано» нельзя.
   */
  const revealText = async (item) => {
    if (!item?.cipher) return item?.text || '';
    const bridge = window.zspeakly?.native;
    if (!bridge?.revealSecret) return null;
    const plain = await bridge.revealSecret(item.cipher).catch(() => null);
    return typeof plain === 'string' ? plain : null;
  };

  const reveal = async (item) => {
    const plain = await revealText(item);
    if (plain == null) {
      push({
        title: 'Расшифровать не удалось',
        description: 'Системное хранилище Windows недоступно — значение не восстановить.',
        tone: 'warn',
        ttl: 7000,
      });
      return;
    }
    setDecrypted((prev) => ({ ...prev, [item.id]: plain }));
    setRevealed((prev) => new Set(prev).add(item.id));
  };

  const copyItem = async (item) => {
    try {
      // пароль лежит в профиле зашифрованным: сначала расшифровываем
      const value = item.cipher ? await revealText(item) : item.text || '';
      if (item.cipher && value == null) {
        push({
          title: 'Пароль не расшифрован',
          description: 'Системное хранилище Windows недоступно.',
          tone: 'warn',
          ttl: 7000,
        });
        return;
      }
      // нативный мост первым: в file:// браузерное API часто запрещено
      await writeClipboard(value, item.image);
      setJustCopied(item.id);
      setTimeout(() => setJustCopied(null), 1400);
      push({ title: 'Скопировано', description: truncate(value, 60), tone: 'success', ttl: 1800 });
    } catch {
      push({
        title: 'Не удалось скопировать',
        description: 'Выделите текст в карточке и нажмите Ctrl+C.',
        tone: 'warn',
      });
    }
  };

  /**
   * Удаление одной записи с возможностью вернуть: в буфере бывают важные
   * фрагменты, а промах мыши стирал их насовсем.
   */
  const removeItem = (item) => {
    if (!item) return;
    removeClipboardItem(item.id);
    setSelectedId(null);
    push({
      title: 'Удалено из буфера',
      description: 'Вернуть можно кнопкой в этом сообщении.',
      tone: 'warn',
      ttl: 8000,
      action: { label: 'Вернуть', onClick: () => addClipboardItem(item) },
    });
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
          <p className="page__sub">
            Всё, что вы захватываете и копируете, — в одном месте.
            {tab === 'password'
              ? ' Пароли хранятся в профиле зашифрованными (системное хранилище Windows), в окно приходит только шифр.'
              : ''}
          </p>
        </div>
        <div className="clip-head__toggle-wrap">
          <span className="clip-head__state">{settings.clipboardMonitor ? 'Включено' : 'Выключено'}</span>
          <Toggle
            label="Мониторинг буфера обмена"
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
            {explicit ? (
              // В сетке нет боковой панели, поэтому действия над выбранной
              // карточкой раньше были недоступны вовсе: оставалось только
              // «Очистить историю». Теперь — компактная панель.
              <div className="clip-actions">
                <span className="clip-actions__label">
                  {kindLabel(selected.kind)} · {selected.source}
                </span>
                <button type="button" className="link-btn" onClick={() => copyItem(selected)}>
                  Копировать
                </button>
                {selected.kind === 'password' && settings.hidePasswords && !revealed.has(selected.id) ? (
                  <button type="button" className="link-btn" onClick={() => reveal(selected)}>
                    Показать
                  </button>
                ) : null}
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => toggleClipboardPin(selected.id)}
                >
                  {selected.pinned ? 'Открепить' : 'Закрепить'}
                </button>
                <button
                  type="button"
                  className="link-btn link-btn--danger"
                  onClick={() => removeItem(selected)}
                >
                  Удалить
                </button>
                <button
                  type="button"
                  className="link-btn"
                  style={{ marginLeft: 'auto' }}
                  onClick={() => setSelectedId(null)}
                >
                  Снять выбор
                </button>
              </div>
            ) : null}
            <div className="clip-grid">
              {filtered.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`clip-card ${explicit?.id === item.id ? 'is-selected' : ''} ${
                    item.pinned ? 'is-pinned' : ''
                  }`}
                  onClick={() => setSelectedId(item.id)}
                  onDoubleClick={() => copyPaste(item)}
                  title={item.kind === 'password' ? 'Пароль (зашифрован)' : item.text || item.source}
                >
                  {item.kind === 'image' && item.image ? (
                    <img className="clip-card__image" src={item.image} alt={item.source || 'Изображение'} />
                  ) : item.kind === 'password' ? (
                    // в профиле только шифр: до «Показать» — маска, после — само значение
                    <div className={`clip-card__text ${decrypted[item.id] ? '' : 'clip-card__text--masked'}`}>
                      {decrypted[item.id] ||
                        '•'.repeat(Math.min(16, Math.max(6, String(item.text || '').length || 10)))}
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
                      className={`clip-list__item ${explicit?.id === item.id ? 'is-selected' : ''}`}
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
                    onClick={() => removeItem(selected)}
                    aria-label="Удалить"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
                <div className="clip-preview__body">
                  {selected.kind === 'note' ? (
                    // Заметка = картинка + подпись, которую можно дописать здесь же
                    <div className="stack-8">
                      {selected.image ? (
                        <img className="clip-preview__img" src={selected.image} alt={selected.source} />
                      ) : null}
                      <textarea
                        className="input clip-preview__note"
                        rows={3}
                        placeholder="Подпись к снимку — например, что на нём важно"
                        value={noteDraft}
                        onChange={(e) => setNoteDraft(e.target.value)}
                      />
                      <div className="row-8">
                        <Button
                          variant="white"
                          size="sm"
                          onClick={() => {
                            updateClipboardItem(selected.id, { text: noteDraft.trim() });
                            push({ title: 'Подпись сохранена', tone: 'success' });
                          }}
                        >
                          Сохранить подпись
                        </Button>
                        <Button
                          variant="bare"
                          size="sm"
                          onClick={() => setNoteDraft(selected.text || '')}
                        >
                          Сбросить
                        </Button>
                      </div>
                    </div>
                  ) : selected.kind === 'image' && selected.image ? (
                    <img className="clip-preview__img" src={selected.image} alt={selected.source} />
                  ) : selected.kind === 'password' && settings.hidePasswords && !revealed.has(selected.id) ? (
                    // настройка «Скрывать пароли»: пока не нажали «Показать», значение замаскировано
                    <span className="clip-preview__masked">
                      {'•'.repeat(Math.min(24, Math.max(8, String(selected.text || '').length)))}
                      <button
                        type="button"
                        className="clip-preview__reveal"
                        onClick={() => reveal(selected)}
                      >
                        Показать
                      </button>
                    </span>
                  ) : selected.cipher && !decrypted[selected.id] ? (
                    <span className="clip-preview__masked">
                      {'•'.repeat(12)}
                      <button type="button" className="clip-preview__reveal" onClick={() => reveal(selected)}>
                        Показать
                      </button>
                    </span>
                  ) : selected.cipher ? (
                    decrypted[selected.id]
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
