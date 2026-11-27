/**
 * Единое состояние ZSpeakly: настройки, история диктовок, словарь,
 * хоткеи, AI-пресеты и буфер обмена. Всё сохраняется локально
 * (localStorage в браузере, profile.json в установленной версии).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { commitBackupSections, read, write, storageBytes } from '../lib/storage.js';
import {
  DEFAULT_AI_PRESETS,
  DEFAULT_CUSTOM_INSTRUCTIONS,
  DEFAULT_SETTINGS,
  DEFAULT_VOICE_HOTKEYS,
  STORAGE_KEYS,
} from '../lib/config.js';
import { uid } from '../lib/utils.js';
import { pruneByAge } from '../lib/retention.js';
import { migrateSettings } from '../lib/settingsMigration.js';
import { tuneSettings } from '../lib/autotune.js';
import { trimByBytes } from '../lib/clipboardBudget.js';
import { isReplaceableClipboardDuplicate } from '../lib/clipboardHistory.js';
import { DICTATION_MAX_BYTES, DICTATION_MAX_ITEMS, dictationBytes, dictationsBytes, trimDictations } from '../lib/dictationBudget.js';
import { useToast } from './ToastProvider.jsx';
import { BACKUP_FORMAT, prepareBackup } from '../lib/backup.js';
import {
  asList,
  sanitizeClipboard,
  sanitizeDictations,
  sanitizeDictionary,
  mergeNewHotkeys,
  sanitizeHotkeys,
  sanitizeInstructions,
  sanitizePresets,
  sanitizeStats,
} from '../lib/sanitize.js';
import { SNIPPET_LIMITS, normalizePhrase, sanitizeSnippets } from '../lib/snippets.js';
import { countDictionaryUsage, rankDictionary } from '../lib/dictionary/rank.js';
import { dictionaryWordKey } from '../lib/dictionary/identity.js';
import { sanitizeAppProfiles } from '../lib/appProfiles.js';

const AppDataContext = createContext(null);

function usePersistentState(key, initialFactory, { merge, sanitize } = {}) {
  // Сид-данные вычисляем один раз: иначе список пересоздавался бы на каждом рендере.
  const initialRef = useRef(null);
  if (initialRef.current === null) {
    initialRef.current = typeof initialFactory === 'function' ? initialFactory() : initialFactory;
  }
  const initial = initialRef.current;

  const [value, setValue] = useState(() => {
    const stored = read(key);
    if (stored === null || stored === undefined) return initial;
    // частичный объект (например, после обновления версии) дополняем дефолтами,
    // иначе UI может упасть на отсутствующем поле
    if (merge && stored && typeof stored === 'object' && !Array.isArray(stored)) {
      return { ...merge, ...stored };
    }
    if (sanitize) return sanitize(stored, initial);
    return stored;
  });

  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      const stored = read(key);
      if (stored === null || stored === undefined) write(key, initial);
      return;
    }
    write(key, value);
  }, [key, value, initial]);

  return [value, setValue];
}

const DEFAULT_STATS = {
  wordsTotal: 0,
  secondsTotal: 0,
  sessions: 0,
};

export function AppDataProvider({ children }) {
  const { push } = useToast();
  const [settings, setSettings] = usePersistentState(STORAGE_KEYS.settings, () => DEFAULT_SETTINGS, {
    merge: DEFAULT_SETTINGS,
  });
  // Новый пользователь начинает с пустой историей, буфером и словарём: раньше
  // здесь подставлялись демонстрационные записи из видео, и приложение
  // выглядело так, будто за вас уже что-то надиктовали и накопировали.
  // Демо-наборы остались только для тестов и скриншотов (src/lib/seed.js).
  // История ограничена и по числу записей, и по весу: длинные расшифровки
  // («встреча на час») весят как сотни коротких, а профиль пишется целиком.
  const [dictations, setDictationsState] = usePersistentState(STORAGE_KEYS.dictations, () => [], {
    // Уже существующие данные не обрезаем при запуске: старые версии могли
    // записать сверх лимита, и обрезка здесь уничтожит их без предупреждения.
    sanitize: sanitizeDictations,
  });
  // Несколько операций в одном React batch должны проверять один и тот же
  // последовательный снимок, а не устаревший снимок последнего рендера.
  const dictationsRef = useRef(dictations);
  const setDictations = useCallback((next) => {
    const value = typeof next === 'function' ? next(dictationsRef.current) : next;
    dictationsRef.current = value;
    setDictationsState(value);
  }, [setDictationsState]);
  const [dictionary, setDictionaryState] = usePersistentState(STORAGE_KEYS.dictionary, () => [], {
    sanitize: sanitizeDictionary,
  });
  const dictionaryRef = useRef(dictionary);
  const setDictionary = useCallback((next) => {
    const value = typeof next === 'function' ? next(dictionaryRef.current) : next;
    dictionaryRef.current = value;
    setDictionaryState(value);
  }, [setDictionaryState]);
  // Быстрые блоки: сказал «моя подпись» — вставился текст. Хранятся рядом со
  // словарём, потому что это тоже «мои слова», но правило другое: словарь
  // правит написание, блок заменяет всю фразу.
  const [snippets, setSnippetsState] = usePersistentState(STORAGE_KEYS.snippets, () => [], {
    sanitize: sanitizeSnippets,
  });
  const snippetsRef = useRef(snippets);
  const setSnippets = useCallback((next) => {
    const value = typeof next === 'function' ? next(snippetsRef.current) : next;
    snippetsRef.current = value;
    setSnippetsState(value);
  }, [setSnippetsState]);
  // Чистим и по весу: история с картинками могла вырасти до десятков мегабайт,
  // и её разбор при запуске был заметен как «приложение долго открывается».
  const [clipboard, setClipboard] = usePersistentState(STORAGE_KEYS.clipboard, () => [], {
    sanitize: (stored, fallback) => trimByBytes(sanitizeClipboard(stored, fallback)),
  });
  const [voiceHotkeys, setVoiceHotkeys] = usePersistentState(
    STORAGE_KEYS.hotkeys,
    () => DEFAULT_VOICE_HOTKEYS,
    {
      // Новые сочетания доезжают и до тех, кто обновляется: иначе новая
      // функция есть, а включить её в профиле прошлой версии нечем.
      sanitize: (stored, fallback) => mergeNewHotkeys(sanitizeHotkeys(stored, fallback), DEFAULT_VOICE_HOTKEYS),
    },
  );
  const [presets, setPresets] = usePersistentState(STORAGE_KEYS.presets, () => DEFAULT_AI_PRESETS, {
    sanitize: sanitizePresets,
  });
  const [instructions, setInstructions] = usePersistentState(
    STORAGE_KEYS.instructions,
    () => DEFAULT_CUSTOM_INSTRUCTIONS,
    { sanitize: sanitizeInstructions },
  );
  const [stats, setStats] = usePersistentState(STORAGE_KEYS.stats, () => DEFAULT_STATS, {
    sanitize: sanitizeStats,
  });
  // профиль — только имя: почта, «подписка» и credits были выдуманными
  // полями из макета и нигде не использовались
  const [profile, setProfile] = usePersistentState(STORAGE_KEYS.profile, () => ({ name: '' }));
  const [merged, setMerged] = useState(false);

  // «Хранить» в настройках данных раньше было декорацией: срок сохранялся,
  // но ничего не удалялось. Теперь старые записи реально вычищаются —
  // при старте и при каждом изменении срока (см. src/lib/retention.js).
  useEffect(() => {
    setDictations((prev) => pruneByAge(prev, settings.dictationRetentionDays));
    // закреплённые записи буфера не трогаем — их сохраняют намеренно
    setClipboard((prev) => pruneByAge(prev, settings.clipboardRetentionDays, { keepPinned: true }));
  }, [
    settings.dictationRetentionDays,
    settings.clipboardRetentionDays,
    setDictations,
    setClipboard,
  ]);

  const warnedOverBudget = useRef(false);
  useEffect(() => {
    if (warnedOverBudget.current) return;
    if (dictationsRef.current.length > DICTATION_MAX_ITEMS || dictationsBytes(dictationsRef.current) > DICTATION_MAX_BYTES) {
      warnedOverBudget.current = true;
      push({ title: 'История превышает лимит', description: 'Сохраните важные записи отдельно и сократите историю. Новые записи пока нельзя добавить; отдельный результат можно сохранить вручную.', tone: 'warn', ttl: 0 });
    }
  }, [push]);

  // Слияние настроек по умолчанию (после добавления новых полей) — один раз
  useEffect(() => {
    if (merged) return;
    // Миграция старых имён моделей и настроек вынесена в
    // src/lib/settingsMigration.js и покрыта тестами — здесь только вызов.
    // 1.6.0: значения, которые раньше были тумблерами (VAD, «держать модель в
    // памяти», лимиты истории, способ вставки), приложение выбирает само.
    setSettings((prev) => {
      const merged = tuneSettings(migrateSettings(prev, DEFAULT_SETTINGS));
      // правила под окно могли прийти из старого профиля или из резервной копии:
      // неизвестный язык или пустое совпадение не должны попасть в работу
      return { ...merged, appProfiles: sanitizeAppProfiles(merged.appProfiles) };
    });
    setMerged(true);
  }, [merged, setSettings]);

  // «Свернуть в трей при закрытии»: главный процесс при закрытии окна читает
  // zs:settings из своего хранилища и падает в дефолт, если веб-сторона туда
  // ничего не положила. Синхронизируем — иначе тумблер был чистой декорацией.
  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.zspeakly?.store : null;
    if (!bridge?.set) return;
    write('zs:settings', settings);
  }, [settings]);

  // Словарь нужен main-процессу: слова уходят в whisper как prompt, иначе
  // имена и термины распознаются «как слышится». Раньше main читал zs:dictionary,
  // а писал туда только рендерер через localStorage — в Electron словарь не доезжал.
  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.zspeakly?.store : null;
    if (!bridge?.set) return;
    // Порядок важен: main обрезает подсказку до лимита, и в неё должны
    // попасть закреплённые и часто диктуемые слова, а не самые новые.
    write('zs:dictionary', rankDictionary(dictionary));
  }, [dictionary]);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    document.documentElement.dataset.reduceMotion = mq?.matches ? 'true' : 'false';
  }, []);

  const addDictation = useCallback(
    (item) => {
      if (item?.id && dictationsRef.current.some((d) => d.id === item.id)) {
        push({ title: 'Запись не добавлена', description: 'Идентификатор уже занят. Скопируйте новый текст вручную.',
          recoverText: item.text, recoverLabel: 'Несохранённый текст истории', tone: 'warn', ttl: 0 });
        return false;
      }
      const oversized = dictationBytes(item) > DICTATION_MAX_BYTES;
      const historyOverBudget = dictationsRef.current.length > DICTATION_MAX_ITEMS || dictationsBytes(dictationsRef.current) > DICTATION_MAX_BYTES;
      if (oversized || historyOverBudget) {
        // Иначе trimDictations может уничтожить уже существующие записи.
        push({
          title: oversized ? 'Запись слишком большая для истории' : 'История превышает лимит',
          description: oversized
            ? 'Она не сохранена в истории. Скопируйте текст отсюда вручную до закрытия уведомления или приложения.'
            : 'Новая запись не добавлена. Скопируйте текст отсюда вручную и сократите историю.',
          recoverText: item.text,
          recoverLabel: 'Несохранённый текст истории',
          tone: 'warn', ttl: 0,
        });
        return false;
      }
      // Даже возврат удалённой записи создаёт новую версию: отложенный ответ
      // не должен незаметно изменять восстановленный человеком объект.
      setDictations((prev) => trimDictations([{ ...item }, ...prev]));
      return true;
    },
    [push, setDictations],
  );

  // Непрозрачный снимок для асинхронных операций: обновление создаёт новый
  // объект, а удаление/восстановление — тоже. Не выбираем произвольно одну из
  // записей старого профиля, если в нём встретились дублирующиеся ID.
  const getDictationSnapshot = useCallback((id) => {
    let found = null;
    for (const item of dictationsRef.current) {
      if (item.id !== id) continue;
      if (found) return null;
      found = item;
    }
    return found;
  }, []);

  const deleteDictation = useCallback((snapshot) => {
    if (!snapshot || getDictationSnapshot(snapshot.id) !== snapshot) {
      push({ title: 'Запись изменилась', description: 'Она не удалена. Закройте просмотр и откройте запись заново.', tone: 'warn', ttl: 9000 });
      return false;
    }
    setDictations((prev) => prev.filter((d) => d !== snapshot));
    return true;
  }, [getDictationSnapshot, push, setDictations]);

  const restoreDictation = useCallback(function restore(snapshot) {
    const current = dictationsRef.current;
    const conflict = current.some((d) => d.id === snapshot?.id);
    const exceedsBudget = current.length + 1 > DICTATION_MAX_ITEMS || dictationsBytes(current) + dictationBytes(snapshot) > DICTATION_MAX_BYTES;
    if (!snapshot || conflict || exceedsBudget) {
      if (snapshot) push({ title: 'Запись не восстановлена',
        description: conflict ? 'Идентификатор уже занят. Скопируйте данные вручную.' : 'История заполнена. Скопируйте данные вручную или освободите место.',
        recoverText: JSON.stringify(snapshot, null, 2), recoverLabel: 'Данные удалённой записи',
        action: { label: 'Повторить возврат', onClick: () => restore(snapshot) }, tone: 'warn', ttl: 0 });
      return false;
    }
    // Возврат не должен вытеснять другие записи или сохранять старую версию объекта.
    setDictations((prev) => [{ ...snapshot }, ...prev]);
    return true;
  }, [push, setDictations]);

  /** Пользователь поправил расшифровку — сохраняем исправленный текст. */
  const updateDictation = useCallback(
    (id, patch, { expectedText } = {}) => {
      const current = dictationsRef.current;
      if (typeof patch?.text === 'string') {
        const oldBytes = dictationsBytes(current);
        let newBytes = oldBytes;
        // Старый профиль может содержать совпадающие ID; map ниже меняет все
        // совпадения, поэтому бюджет тоже проверяем для всех, а не первого.
        for (const d of current) {
          if (d.id !== id || (expectedText !== undefined && d.text !== expectedText)) continue;
          newBytes += dictationBytes({ ...d, ...patch }) - dictationBytes(d);
        }
        // Не теряем старые записи из-за расширения другой записи. Если история
        // уже выше лимита, уменьшение разрешено, чтобы её можно было сократить.
        if (newBytes > DICTATION_MAX_BYTES && newBytes > oldBytes) return false;
      }
      setDictations((prev) =>
        prev.map((d) => (d.id === id && (expectedText === undefined || d.text === expectedText)
          ? { ...d, ...patch, editedAt: Date.now() } : d)),
      );
      // Это принятие запроса, не подтверждение совпадения expectedText или диска.
      return true;
    },
    [setDictations],
  );

  // Ручная правка применима только к единственной неизменённой версии.
  const saveDictationEdit = useCallback((snapshot, patch) => {
    if (!snapshot || getDictationSnapshot(snapshot.id) !== snapshot) return { ok: false, reason: 'changed' };
    const current = dictationsRef.current;
    const oldBytes = dictationsBytes(current);
    const newBytes = oldBytes + dictationBytes({ ...snapshot, ...patch }) - dictationBytes(snapshot);
    if (newBytes > DICTATION_MAX_BYTES && newBytes > oldBytes) return { ok: false, reason: 'budget' };
    setDictations((prev) => prev.map((d) => d === snapshot ? { ...d, ...patch, editedAt: Date.now() } : d));
    return { ok: true };
  }, [getDictationSnapshot, setDictations]);

  const clearDictations = useCallback(() => setDictations([]), [setDictations]);

  const recordWords = useCallback(
    (count = 0, durationMs = 0) => {
      setStats((prev) => ({
        ...prev,
        wordsTotal: prev.wordsTotal + count,
        secondsTotal: prev.secondsTotal + durationMs / 1000,
      }));
    },
    [setStats],
  );

  // Правка любой настройки проходит через tuneSettings: если интерфейс (или
  // старая версия профиля) попытается выставить значение, которое приложение
  // выбирает само, оно тут же вернётся к идеальному.
  const updateSettings = useCallback(
    (patch) => setSettings((prev) => tuneSettings({ ...prev, ...patch })),
    [setSettings],
  );

  const addDictionaryWord = useCallback(
    (word, pronunciation, { pinned = false } = {}) => {
      const clean = String(word || '').trim();
      const key = dictionaryWordKey(clean);
      if (!key) return null;
      if (dictionaryRef.current.some((w) => dictionaryWordKey(w.word) === key)) {
        push({ title: 'Слово уже есть в словаре', description: 'Существующее слово не изменено. Для правки откройте его в списке.', tone: 'warn', ttl: 9000 });
        return null;
      }
      const entry = { id: uid('dict'), word: clean, pronunciation: String(pronunciation || '').trim(),
        createdAt: Date.now(), pinned: pinned === true, hits: 0, lastUsedAt: 0 };
      setDictionary((prev) => [entry, ...prev]);
      return entry;
    },
    [push, setDictionary],
  );

  const updateDictionaryWord = useCallback((snapshot, patch) => {
    // Проверяем именно снимок, а не только id/текст: удаление-возврат и
    // закрепление во время открытого окна не должны затираться старой формой.
    const current = dictionaryRef.current.find((w) => w.id === snapshot?.id);
    if (!snapshot || current !== snapshot) {
      push({ title: 'Слово изменилось', description: 'Правка не сохранена. Скопируйте черновик, закройте окно и откройте слово заново.', tone: 'warn', ttl: 9000 });
      return null;
    }
    const word = String(patch?.word || '').trim();
    const key = dictionaryWordKey(word);
    if (!key) return null;
    if (dictionaryRef.current.some((w) => w !== current && dictionaryWordKey(w.word) === key)) {
      push({ title: 'Слово уже есть в словаре', description: 'Правка не сохранена. Выберите другое слово.', tone: 'warn', ttl: 9000 });
      return null;
    }
    const entry = { ...current, word, pronunciation: String(patch?.pronunciation || '').trim(), pinned: patch?.pinned === true };
    setDictionary((prev) => prev.map((w) => (w === current ? entry : w)));
    return entry;
  }, [push, setDictionary]);

  const restoreDictionaryWord = useCallback((entry) => {
    if (dictionaryRef.current.some((w) => w.id === entry.id)) {
      push({ title: 'Слово не восстановлено', description: 'Идентификатор уже занят. Скопируйте данные вручную до закрытия уведомления.',
        recoverText: JSON.stringify(entry, null, 2), recoverLabel: 'Данные удалённого слова', tone: 'warn', ttl: 0 });
      return false;
    }
    // Явный возврат может создать одинаковые слова, но не меняет новую запись.
    setDictionary((prev) => [{ ...entry }, ...prev]);
    return true;
  }, [push, setDictionary]);

  const removeDictionaryWord = useCallback(
    (id) => setDictionary((prev) => prev.filter((w) => w.id !== id)),
    [setDictionary],
  );

  /** Закрепить/открепить слово: закреплённые идут первыми в подсказке движку. */
  const toggleDictionaryPin = useCallback(
    (id) =>
      setDictionary((prev) => prev.map((w) => (w.id === id ? { ...w, pinned: !w.pinned } : w))),
    [setDictionary],
  );

  /**
   * После удачной диктовки отмечаем слова, которые в ней действительно
   * прозвучали. Это не статистика ради статистики: по этим счётчикам словарь
   * сортируется, и в короткую подсказку движку попадают нужные термины.
   */
  const noteDictionaryUsage = useCallback(
    (text) => {
      setDictionary((prev) => {
        const { list, changed } = countDictionaryUsage(prev, text);
        return changed.length ? list : prev;
      });
    },
    [setDictionary],
  );

  const addSnippet = useCallback(
    (trigger, body) => {
      const cleanTrigger = String(trigger || '').replace(/\s+/gu, ' ').trim();
      const cleanBody = String(body || '');
      const key = normalizePhrase(cleanTrigger);
      let problem = '';
      if (!key || !cleanBody.trim()) problem = 'Укажите фразу и непустой текст.';
      else if (/[«»“”"]/u.test(cleanTrigger)) problem = 'Уберите кавычки из фразы: цитаты не запускают быстрый блок.';
      else if (cleanTrigger.length > SNIPPET_LIMITS.trigger || cleanBody.length > SNIPPET_LIMITS.body)
        problem = `Фраза — не более ${SNIPPET_LIMITS.trigger}, текст — не более ${SNIPPET_LIMITS.body} символов. Ничего не обрезано.`;
      else if (snippetsRef.current.some((s) => normalizePhrase(s.trigger) === key))
        problem = 'Блок с такой фразой уже существует. Старый текст не изменён; выберите другую фразу.';
      else if (snippetsRef.current.length >= SNIPPET_LIMITS.count)
        problem = `Достигнут лимит ${SNIPPET_LIMITS.count} блоков. Существующие блоки не изменены.`;
      if (problem) {
        push({ title: 'Блок не сохранён', description: problem, tone: 'warn', ttl: 9000 });
        return null;
      }
      const entry = { id: uid('snip'), trigger: cleanTrigger, body: cleanBody, createdAt: Date.now() };
      setSnippets((prev) => [entry, ...prev]);
      return entry;
    },
    [push, setSnippets],
  );

  const removeSnippet = useCallback((id) => setSnippets((prev) => prev.filter((s) => s.id !== id)), [setSnippets]);

  // Отмена удаления возвращает исходный объект, даже если он старее лимитов.
  const restoreSnippet = useCallback((entry) => {
    if (snippetsRef.current.some((s) => s.id === entry.id)) {
      push({ title: 'Блок не восстановлен', description: 'Идентификатор уже занят. Скопируйте текст вручную.',
        recoverText: entry.body, recoverLabel: 'Текст удалённого блока', tone: 'warn', ttl: 0 });
      return false;
    }
    setSnippets((prev) => [entry, ...prev]);
    return true;
  }, [push, setSnippets]);

  const addClipboardItem = useCallback(
    (item) => {
      setClipboard((prev) => {
        if (item.hidePasswords && item.kind === 'password') return prev;
        // Закреплённое не удаляется при повторном копировании. Разные заметки,
        // изображения и видео могут иметь одинаковый текст, но это не дубликаты.
        const dedup = prev.filter((entry) => !isReplaceableClipboardDuplicate(entry, item));
        const next = [{ ...item, id: item.id || uid('clip'), createdAt: item.createdAt || Date.now() }, ...dedup];
        // Лимит истории не должен выбрасывать закреплённое: человек закрепил
        // запись именно для того, чтобы она осталась.
        const limit = settings.clipboardMaxItems || 10000;
        const kept = [];
        for (const entry of next) {
          if (kept.length < limit || entry.pinned) kept.push(entry);
        }
        return trimByBytes(kept);
      });
    },
    [setClipboard, settings.clipboardMaxItems],
  );

  const removeClipboardItem = useCallback(
    (id) => setClipboard((prev) => prev.filter((c) => c.id !== id)),
    [setClipboard],
  );

  /** Правка записи буфера: нужна для «скриншота с заметкой» — подпись пишет человек. */
  const updateClipboardItem = useCallback(
    (id, patch) =>
      setClipboard((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch, editedAt: Date.now() } : c))),
    [setClipboard],
  );

  const toggleClipboardPin = useCallback(
    (id) => setClipboard((prev) => prev.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c))),
    [setClipboard],
  );

  const clearClipboard = useCallback(() => setClipboard((prev) => prev.filter((c) => c.pinned)), [setClipboard]);

  const toggleHotkey = useCallback(
    (id) => setVoiceHotkeys((prev) => prev.map((h) => (h.id === id ? { ...h, enabled: !h.enabled } : h))),
    [setVoiceHotkeys],
  );

  const updateHotkey = useCallback(
    (id, patch) => setVoiceHotkeys((prev) => prev.map((h) => (h.id === id ? { ...h, ...patch } : h))),
    [setVoiceHotkeys],
  );

  const resetHotkeys = useCallback(() => setVoiceHotkeys(DEFAULT_VOICE_HOTKEYS), [setVoiceHotkeys]);

  const togglePreset = useCallback(
    (id) => setPresets((prev) => prev.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p))),
    [setPresets],
  );

  const updatePresetKeys = useCallback(
    (id, keys) => setPresets((prev) => prev.map((p) => (p.id === id ? { ...p, keys } : p))),
    [setPresets],
  );

  const addInstruction = useCallback(
    (data) => {
      const entry = {
        id: uid('instr'),
        title: String(data.title || 'Новая инструкция').trim(),
        prompt: String(data.prompt || '').trim(),
        keys: data.keys || [],
        description: String(data.description || '').trim(),
        enabled: true,
        createdAt: Date.now(),
      };
      setInstructions((prev) => [entry, ...prev]);
      return entry;
    },
    [setInstructions],
  );

  const removeInstruction = useCallback(
    (id) => setInstructions((prev) => prev.filter((i) => i.id !== id)),
    [setInstructions],
  );

  const updateInstruction = useCallback(
    (id, patch) => setInstructions((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i))),
    [setInstructions],
  );

  const resetAll = useCallback(() => {
    setDictations([]);
    setClipboard([]);
    setDictionary([]);
    setSnippets([]);
    setInstructions([]);
    setPresets(DEFAULT_AI_PRESETS);
    setVoiceHotkeys(DEFAULT_VOICE_HOTKEYS);
    setSettings(DEFAULT_SETTINGS);
    setStats(DEFAULT_STATS);
    // имя живёт и в профиле: без этого после сброса в сайдбаре оставалось
    // прежнее имя, хотя приложение обещало «настройки по умолчанию»
    setProfile({ name: '' });
  }, [
    setDictations, setClipboard, setDictionary, setSnippets,
    setInstructions, setPresets, setVoiceHotkeys, setSettings, setStats, setProfile,
  ]);

  const bytes = useMemo(() => storageBytes(), [dictations, clipboard, dictionary, snippets]);

  // Резервная копия: словарь, инструкции, настройки, пресеты и история.
  // Буфер обмена намеренно не выгружается — там бывают пароли и коды.
  const exportBackup = useCallback(
    () => ({
      app: 'ZSpeakly',
      format: BACKUP_FORMAT,
      exportedAt: new Date().toISOString(),
      settings,
      dictations,
      dictionary,
      snippets,
      voiceHotkeys,
      presets,
      instructions,
      stats,
      profile,
    }),
    [settings, dictations, dictionary, snippets, voiceHotkeys, presets, instructions, stats, profile],
  );

  const importBackup = useCallback(
    (payload) => {
      // Вся проверка и подготовка предшествует первому setState: неисправный
      // поздний раздел не должен уже успеть заменить историю или настройки.
      const data = prepareBackup(payload);
      // Проверяем непосредственно перед первым изменением, а не при выборе
      // файла: за время предпросмотра состояние диска могло измениться.
      const sectionKeys = {
        settings: STORAGE_KEYS.settings, dictations: STORAGE_KEYS.dictations, dictionary: STORAGE_KEYS.dictionary,
        snippets: STORAGE_KEYS.snippets, voiceHotkeys: STORAGE_KEYS.hotkeys, presets: STORAGE_KEYS.presets,
        instructions: STORAGE_KEYS.instructions, stats: STORAGE_KEYS.stats, profile: STORAGE_KEYS.profile,
      };
      const sections = Object.fromEntries(Object.entries(data).map(([key, value]) => [sectionKeys[key], value]));
      // При отказе до setState UI сохраняет старые разделы. Если ответ IPC
      // потерян, нельзя обещать, что диск остался прежним.
      commitBackupSections(sections);
      const applied = [];
      if (data.settings) {
        setSettings(data.settings);
        applied.push('настройки');
      }
      if (data.dictations) {
        setDictations(data.dictations);
        applied.push(`диктовки (${data.dictations.length})`);
      }
      if (data.dictionary) {
        setDictionary(data.dictionary);
        applied.push(`словарь (${data.dictionary.length})`);
      }
      if (data.snippets) {
        setSnippets(data.snippets);
        applied.push(`быстрые блоки (${data.snippets.length})`);
      }
      if (data.voiceHotkeys) {
        setVoiceHotkeys(data.voiceHotkeys);
        applied.push('голосовые сочетания');
      }
      if (data.presets) {
        setPresets(data.presets);
        applied.push(`AI-инструкции (${data.presets.length})`);
      }
      if (data.instructions) {
        setInstructions(data.instructions);
        applied.push(`свои инструкции (${data.instructions.length})`);
      }
      if (data.stats) {
        setStats(data.stats);
        applied.push('счётчики');
      }
      if (data.profile) {
        setProfile(data.profile);
        applied.push('профиль');
      }
      return applied;
    },
    [setSettings, setDictations, setDictionary, setSnippets, setVoiceHotkeys, setPresets, setInstructions, setStats, setProfile],
  );

  const value = useMemo(
    () => ({
      settings,
      updateSettings,
      dictations,
      addDictation,
      deleteDictation,
      restoreDictation,
      updateDictation,
      getDictationSnapshot,
      saveDictationEdit,
      clearDictations,
      dictionary,
      addDictionaryWord,
      updateDictionaryWord,
      restoreDictionaryWord,
      removeDictionaryWord,
      toggleDictionaryPin,
      noteDictionaryUsage,
      snippets,
      addSnippet,
      removeSnippet,
      restoreSnippet,
      clipboard,
      addClipboardItem,
      removeClipboardItem,
      updateClipboardItem,
      toggleClipboardPin,
      clearClipboard,
      voiceHotkeys,
      toggleHotkey,
      updateHotkey,
      resetHotkeys,
      presets,
      togglePreset,
      updatePresetKeys,
      instructions,
      addInstruction,
      removeInstruction,
      updateInstruction,
      stats,
      recordWords,
      profile,
      setProfile,
      resetAll,
      exportBackup,
      importBackup,
      storageSize: bytes,
    }),
    [
      exportBackup, importBackup,
      settings, updateSettings, dictations, addDictation, deleteDictation, restoreDictation, updateDictation, getDictationSnapshot, saveDictationEdit, clearDictations,
      dictionary,
      addDictionaryWord,
      updateDictionaryWord,
      restoreDictionaryWord,
      removeDictionaryWord,
      toggleDictionaryPin,
      noteDictionaryUsage,
      snippets,
      addSnippet,
      removeSnippet,
      restoreSnippet,
      clipboard,
      addClipboardItem,
      removeClipboardItem, updateClipboardItem, toggleClipboardPin, clearClipboard, voiceHotkeys, toggleHotkey,
      updateHotkey, resetHotkeys, presets, togglePreset, updatePresetKeys, instructions, addInstruction,
      removeInstruction, updateInstruction, stats, recordWords, profile, setProfile, resetAll, bytes,
    ],
  );

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

export function useAppData() {
  const ctx = useContext(AppDataContext);
  if (!ctx) throw new Error('useAppData must be used inside AppDataProvider');
  return ctx;
}

export default AppDataProvider;
