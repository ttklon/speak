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
import { clipboardCopyError, readClipboard, writeClipboard } from '../lib/clipboard.js';
import { useToast } from '../state/ToastProvider.jsx';
import { Toggle } from '../components/ui/Toggle.jsx';
import ConfirmDialog from '../components/ui/ConfirmDialog.jsx';
import { Button, EmptyState, SearchInput } from '../components/ui/Controls.jsx';
import { CLIPBOARD_TABS, DEFAULT_SETTINGS } from '../lib/config.js';
import { dayLabel, formatSeconds, kindLabel, timeHM, truncate } from '../lib/utils.js';
import { navigate, useRoute } from '../lib/router.js';
import { startScreenRecording, isRecordingSupported } from '../lib/media/recorder.js';
import { saveScreenRecording } from '../lib/media/saveRecording.js';

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
  const route = useRoute();
  // Ссылка #/clipboard?tab=image обещала открыть «Изображения», но страница
  // параметр не читала и всегда показывала «Все».
  const tabFromUrl = CLIPBOARD_TABS.some((t) => t.id === route.params?.tab) ? route.params.tab : '';
  const [tab, setTab] = useState(tabFromUrl || 'all');
  const [view, setView] = useState('grid');
  useEffect(() => {
    if (tabFromUrl) setTab(tabFromUrl);
  }, [tabFromUrl]);

  // очистка истории — только после подтверждения: один промах мыши не должен
  // стирать всё, что накопилось за день
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmDiscardVideo, setConfirmDiscardVideo] = useState(false);
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
  const [pendingVideo, setPendingVideo] = useState(null);
  const [savingVideo, setSavingVideo] = useState(false);
  const savingVideoRef = useRef(false);
  const pendingVideoRef = useRef(null);
  const recordingRef = useRef(null);
  const captureStarting = useRef(false);
  const captureStopping = useRef(false);
  const mounted = useRef(false);
  const lastExternal = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const active = recordingRef.current;
      recordingRef.current = null;
      try { active?.cancel(); } catch { /* дорожки останавливаются в cancel */ }
    };
  }, []);

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
      // Старые записи паролей могут содержать открытый текст. Поиск по нему
      // раскрывал совпадение даже при включённой маске.
      const searchableText = item.kind === 'password' ? '' : item.text || '';
      return `${searchableText} ${item.source || ''}`.toLowerCase().includes(q);
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

  const savePendingVideo = async (result) => {
    if (!result || savingVideoRef.current) return;
    savingVideoRef.current = true;
    if (mounted.current) setSavingVideo(true);
    try {
      const saved = await saveScreenRecording(result.blob, result.name, window.zspeakly?.native);
      pendingVideoRef.current = null;
      if (!mounted.current) return;
      setPendingVideo(null);
      if (saved.saved) {
        let historyFailed = false;
        try {
          addClipboardItem({
            kind: 'file',
            text: `Запись экрана · ${formatSeconds(result.durationMs)} · ${result.sizeMb} МБ${result.hasAudioTrack ? '' : ' · без звука'}`,
            image: result.poster || '',
            source: 'Запись экрана — ZSpeakly',
            createdAt: Date.now(),
          });
        } catch { historyFailed = true; }
        const limitNote = result.limitReason === 'size' ? 'Запись остановлена по размеру.' : result.limitReason === 'duration' ? 'Запись остановлена по времени.' : '';
        const notes = [limitNote, result.interrupted && 'Видео может быть неполным.', historyFailed && 'Не удалось добавить запись в историю.', saved.path || 'Файл в папке Видео.'].filter(Boolean).join(' ');
        push({
          title: result.interrupted ? 'Запись могла прерваться' : limitNote ? 'Запись остановлена по ограничению' : 'Запись сохранена',
          description: notes,
          tone: result.interrupted || historyFailed || limitNote ? 'warn' : 'success',
        });
      } else {
        const limited = result.limitReason === 'size' || result.limitReason === 'duration';
        push({ title: 'Загрузка запрошена', description: result.interrupted || limited ? 'Запись прервана или остановлена по ограничению. Проверьте файл в браузере.' : 'Проверьте, что браузер сохранил файл.', tone: result.interrupted || limited ? 'warn' : 'success' });
      }
    } catch {
      if (mounted.current) push({
        title: 'Не удалось сохранить запись',
        description: 'Видео пока в памяти. Повторите сохранение; частичный файл может остаться в папке Видео.',
        tone: 'warn',
        ttl: 7000,
      });
    } finally {
      savingVideoRef.current = false;
      captureStopping.current = false;
      if (mounted.current) setSavingVideo(false);
    }
  };

  /** Запись экрана: один обработчик результата для кнопки и системной остановки. */
  const toggleRecording = async ({ audio = true } = {}) => {
    if (!mounted.current || captureStarting.current || captureStopping.current || savingVideoRef.current) return;
    if (pendingVideoRef.current) {
      push({ title: 'Сначала сохраните или удалите предыдущую запись', tone: 'warn' });
      return;
    }
    const active = recordingRef.current;
    if (active) {
      captureStopping.current = true;
      try {
        await active.stop();
      } catch {
        if (recordingRef.current !== active) return;
        try { active.cancel(); } catch { /* дорожки останавливаются в cancel */ }
        recordingRef.current = null;
        captureStopping.current = false;
        if (mounted.current) {
          setRecording(null);
          push({ title: 'Не удалось остановить запись', description: 'Попытались остановить захват; видео не сохранено.', tone: 'warn' });
        }
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
    captureStarting.current = true;
    try {
      const rec = await startScreenRecording({ audio, onTick: (ms) => { if (mounted.current) setRecordMs(ms); } });
      // Системный выбор может завершиться уже после ухода со страницы.
      if (!mounted.current) {
        rec.cancel();
        return;
      }
      recordingRef.current = rec;
      setRecordMs(0);
      setRecording(rec);
      push({
        title: 'Запись пошла',
        description: `${rec.hasAudioTrack ? 'Аудиодорожка получена.' : 'Запись идёт без системного звука.'} Нажмите «Запись экрана» ещё раз, чтобы остановить. При уходе со страницы запись отменится.`,
        tone: rec.hasAudioTrack ? 'success' : 'warn',
      });
      rec.finished.then(async (result) => {
        // Отмена на уходе и ошибка stop не должны запускать сохранение.
        if (!mounted.current || recordingRef.current !== rec) return;
        recordingRef.current = null;
        captureStopping.current = true;
        setRecording(null);
        if (!result?.blob?.size) {
          captureStopping.current = false;
          if (result?.limitReason === 'overflow') {
            push({ title: 'Запись не сохранена', description: 'Фрагмент превысил предел 64 МиБ; неполное видео не сохранялось.', tone: 'warn', ttl: 9000 });
          } else {
            push({ title: 'Запись пустая', tone: 'warn' });
          }
          return;
        }
        const pending = { ...result, name: `ZSpeakly-${Date.now()}.webm` };
        pendingVideoRef.current = pending;
        setPendingVideo(pending);
        await savePendingVideo(pending);
      }).catch(() => {
        if (!mounted.current || recordingRef.current !== rec) return;
        recordingRef.current = null;
        captureStopping.current = false;
        if (mounted.current) {
          setRecording(null);
          push({ title: 'Не удалось обработать запись', description: 'Видео не сохранено.', tone: 'warn' });
        }
      });
    } catch (err) {
      if (mounted.current) {
        const retryWithoutAudio = audio && err?.name === 'NotReadableError';
        push({
          title: 'Не удалось начать запись',
          description: retryWithoutAudio
            ? 'Не удалось открыть источник экрана или звука. Можно отдельно попробовать запись без системного звука.'
            : err?.name === 'NotAllowedError' ? 'Выбор экрана отменён' : String(err?.message || err),
          tone: 'warn',
          ...(retryWithoutAudio ? {
            ttl: 0,
            action: {
              label: 'Записать без звука',
              onClick: () => {
                if (!mounted.current) return;
                if (recordingRef.current || captureStarting.current || captureStopping.current || savingVideoRef.current || pendingVideoRef.current) {
                  push({ title: 'Новая запись сейчас недоступна', tone: 'warn' });
                  return;
                }
                void toggleRecording({ audio: false });
              },
            },
          } : {}),
        });
      }
    } finally {
      captureStarting.current = false;
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
   * Открытый текст записи: при наличии шифра спрашиваем значение у main.
   * Старые записи могут содержать открытый текст. null означает, что
   * расшифровать значение не удалось.
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

  const copyItem = async (item, textOnly = false) => {
    try {
      // Если есть шифр, сначала получаем открытое значение через main.
      const value = item.cipher ? await revealText(item) : item.text || '';
      if (item.cipher && value == null) {
        push({
          title: 'Пароль не расшифрован',
          description: 'Системное хранилище Windows недоступно.',
          tone: 'warn',
          ttl: 7000,
        });
        return false;
      }
      if (textOnly && !value) {
        push({ title: 'В записи нет текста', tone: 'warn' });
        return false;
      }
      // нативный мост первым: в file:// браузерное API часто запрещено
      await writeClipboard(value, textOnly ? undefined : item.image);
      setJustCopied(item.id);
      setTimeout(() => setJustCopied(null), 1400);
      // Не раскрывать распознанный пароль в уведомлении даже после копирования.
      // Обычный текст тоже может содержать нераспознанный секрет.
      const description = item.kind === 'password' || item.cipher ? 'Значение скопировано в системный буфер.' : truncate(value, 60);
      push({ title: 'Скопировано', description, tone: 'success', ttl: 1800 });
      return true;
    } catch (err) {
      push(clipboardCopyError(err, item.image && !textOnly ? 'Изображение может быть повреждено или слишком велико, либо системный буфер недоступен.' : 'Выделите текст в карточке и нажмите Ctrl+C.'));
      return false;
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
    let outcome = false;
    if (window.zspeakly?.isElectron) {
      const pasteItem = window.zspeakly?.native?.pasteClipboardItem;
      if (!pasteItem) {
        push({ title: 'Автовставка недоступна', description: 'Запись не копировалась. Скопируйте её вручную.', tone: 'warn' });
        return;
      }
      const value = item.cipher ? await revealText(item) : item.text || '';
      if (item.cipher && value == null) {
        push({ title: 'Пароль не расшифрован', description: 'Системное хранилище Windows недоступно.', tone: 'warn', ttl: 7000 });
        return;
      }
      let result;
      try { result = await pasteItem({ text: value, image: item.image }); }
      catch { result = null; } // IPC мог оборваться после Ctrl+V.
      if (result?.busy) {
        push({ title: 'Другая операция с текстом ещё выполняется', description: 'Запись не вставлена и не скопирована. Повторите действие позже.', tone: 'warn' });
        return;
      }
      if (result?.copyFailed) {
        push({ title: 'Не удалось скопировать', description: 'Вставка не запускалась. Проверьте запись и системный буфер.', tone: 'warn' });
        return;
      }
      if (!result?.copied) outcome = { uncertain: true };
      else {
        setJustCopied(item.id);
        setTimeout(() => setJustCopied(null), 1400);
        outcome = result.outcome;
      }
    } else {
      // В браузере нет системного IPC: сохраняем прежний явный fallback.
      if (!(await copyItem(item))) return;
      const paste = window.zspeakly?.native?.pasteToActive;
      try { if (paste) outcome = await paste(); }
      catch { outcome = { uncertain: true }; }
    }
    if (outcome === true) return;
    if (outcome !== false) {
      push({
        title: 'Не удалось подтвердить автовставку',
        description: 'Содержимое могло попасть в окно. Проверьте окно перед повтором.',
        tone: 'warn',
      });
      return;
    }
    push({
      title: 'Автовставка не удалась',
      description: 'Проверьте окно назначения и при необходимости вставьте вручную.',
      tone: 'warn',
    });
  };

  return (
    <div className="page page--clipboard">
      <div className="clip-head">
        <div>
          <h1 className="page__title">Буфер обмена</h1>
          <p className="page__sub">
            Всё, что вы захватываете и копируете, — в одном месте.
            {' '}Распознавание паролей приблизительное: секрет может сохраниться как обычный текст.
            При недоступном шифровании похожие на пароль значения тоже могут сохраниться открыто.
            Чтобы ограничить сбор, отключите мониторинг; прежние записи останутся.
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
                description: v
                  ? 'Буфер снова опрашивается; текущее содержимое тоже может попасть в историю.'
                  : 'Опрос будет остановлен после применения настройки. Прежние записи остаются.',
              });
            }}
          />
          <button
            type="button"
            className="icon-btn"
            onClick={() => navigate('settings', { section: 'dictation', from: 'clipboard' })}
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
      <p className="page__sub">Запись экрана останавливается примерно при 48 МиБ или примерно через 10 минут. При превышении 64 МиБ видео не сохранится.</p>
      {recording ? <p className="page__sub" role="status">{recording.hasAudioTrack ? 'Аудиодорожка получена; наличие звука в записи не гарантировано. ' : 'Запись идёт без системного звука. '}При переходе на другую страницу запись отменится и не сохранится. Сначала остановите её здесь.</p> : null}
      {pendingVideo ? (
        <div className="stack-8" role="status">
          <p className="page__sub">{savingVideo ? 'Сохраняем запись…' : 'Запись осталась только в памяти. При уходе со страницы или закрытии приложения она будет потеряна.'}</p>
          {!savingVideo ? (
            <div className="row-8">
              <Button size="sm" onClick={() => savePendingVideo(pendingVideoRef.current)}>Повторить сохранение</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDiscardVideo(true)}>Удалить несохранённую запись</Button>
            </div>
          ) : null}
        </div>
      ) : null}

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
                  title={item.kind === 'password' ? (item.cipher ? 'Пароль (зашифрован)' : 'Пароль (открытый текст)') : item.text || item.source}
                >
                  {item.kind === 'image' && item.image ? (
                    <img className="clip-card__image" src={item.image} alt={item.source || 'Изображение'} />
                  ) : item.kind === 'password' ? (
                    // До «Показать» — маска, независимо от наличия шифра.
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
                    onClick={() => copyItem(selected, true)}
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
        open={confirmDiscardVideo}
        onClose={() => setConfirmDiscardVideo(false)}
        onConfirm={() => { pendingVideoRef.current = null; setPendingVideo(null); }}
        title="Удалить несохранённую запись?"
        description="Видео находится только в памяти и будет потеряно без возможности повтора."
        confirmLabel="Удалить запись"
      />
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
