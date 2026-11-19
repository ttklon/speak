/**
 * Единое состояние ZSpeakly: настройки, история диктовок, словарь,
 * хоткеи, AI-пресеты и буфер обмена. Всё сохраняется локально
 * (localStorage в браузере, profile.json в установленной версии).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { read, write, storageBytes } from '../lib/storage.js';
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
import { trimDictations } from '../lib/dictationBudget.js';
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
  const [settings, setSettings] = usePersistentState(STORAGE_KEYS.settings, () => DEFAULT_SETTINGS, {
    merge: DEFAULT_SETTINGS,
  });
  // Новый пользователь начинает с пустой историей, буфером и словарём: раньше
  // здесь подставлялись демонстрационные записи из видео, и приложение
  // выглядело так, будто за вас уже что-то надиктовали и накопировали.
  // Демо-наборы остались только для тестов и скриншотов (src/lib/seed.js).
  // История ограничена и по числу записей, и по весу: длинные расшифровки
  // («встреча на час») весят как сотни коротких, а профиль пишется целиком.
  const [dictations, setDictations] = usePersistentState(STORAGE_KEYS.dictations, () => [], {
    sanitize: (stored, fallback) => trimDictations(sanitizeDictations(stored, fallback)),
  });
  const [dictionary, setDictionary] = usePersistentState(STORAGE_KEYS.dictionary, () => [], {
    sanitize: sanitizeDictionary,
  });
  // Быстрые блоки: сказал «моя подпись» — вставился текст. Хранятся рядом со
  // словарём, потому что это тоже «мои слова», но правило другое: словарь
  // правит написание, блок заменяет всю фразу.
  const [snippets, setSnippets] = usePersistentState(STORAGE_KEYS.snippets, () => [], {
    sanitize: sanitizeSnippets,
  });
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

  // Слияние настроек по умолчанию (после добавления новых полей) — один раз
  useEffect(() => {
    if (merged) return;
    // 1.5.1: старые умолчания (small + живая расшифровка) превращали
    // 30-секундную диктовку в минуту ожидания. Миграция вынесена в
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
    try {
      bridge.set('zs:settings', settings);
    } catch (err) {
      console.warn('[settings] не удалось передать настройки в главный процесс', err);
    }  }, [settings]);

  // Словарь нужен main-процессу: слова уходят в whisper как prompt, иначе
  // имена и термины распознаются «как слышится». Раньше main читал zs:dictionary,
  // а писал туда только рендерер через localStorage — в Electron словарь не доезжал.
  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.zspeakly?.store : null;
    if (!bridge?.set) return;
    try {
      // Порядок важен: main обрезает подсказку до лимита, и в неё должны
      // попасть закреплённые и часто диктуемые слова, а не самые новые.
      bridge.set('zs:dictionary', rankDictionary(dictionary));
    } catch (err) {
      console.warn('[dictionary] не удалось передать словарь в главный процесс', err);
    }
  }, [dictionary]);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    document.documentElement.dataset.reduceMotion = mq?.matches ? 'true' : 'false';
  }, []);

  const addDictation = useCallback(
    (item) => {
      setDictations((prev) => trimDictations([item, ...prev]));
    },
    [setDictations],
  );

  const deleteDictation = useCallback(
    (id) => setDictations((prev) => prev.filter((d) => d.id !== id)),
    [setDictations],
  );

  /** Пользователь поправил расшифровку — сохраняем исправленный текст. */
  const updateDictation = useCallback(
    (id, patch) =>
      setDictations((prev) =>
        prev.map((d) => (d.id === id ? { ...d, ...patch, editedAt: Date.now() } : d)),
      ),
    [setDictations],
  );

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
      if (!clean) return null;
      const entry = {
        id: uid('dict'),
        word: clean,
        pronunciation: String(pronunciation || '').trim(),
        createdAt: Date.now(),
        pinned: pinned === true,
        hits: 0,
        lastUsedAt: 0,
      };
      // то же слово (без учёта регистра) не дублируем, а обновляем: иначе список
      // рос бы копиями, а whisper получал бы один и тот же термин дважды
      setDictionary((prev) => [entry, ...prev.filter((w) => w.word.toLowerCase() !== clean.toLowerCase())]);
      return entry;
    },
    [setDictionary],
  );

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
      const cleanBody = String(body || '').trim();
      if (!cleanTrigger || !cleanBody) return null;
      const entry = {
        id: uid('snip'),
        trigger: cleanTrigger.slice(0, SNIPPET_LIMITS.trigger),
        body: cleanBody.slice(0, SNIPPET_LIMITS.body),
        createdAt: Date.now(),
      };
      // Тот же триггер (без учёта регистра и знаков) не дублируем, а заменяем:
      // иначе человек не поймёт, какой из двух блоков сработал.
      const key = normalizePhrase(entry.trigger);
      setSnippets((prev) => [entry, ...prev.filter((s) => normalizePhrase(s.trigger) !== key)]);
      return entry;
    },
    [setSnippets],
  );

  const removeSnippet = useCallback((id) => setSnippets((prev) => prev.filter((s) => s.id !== id)), [setSnippets]);

  const addClipboardItem = useCallback(
    (item) => {
      setClipboard((prev) => {
        if (item.hidePasswords && item.kind === 'password') return prev;
        // у зашифрованного пароля текста нет — сравниваем шифр, иначе все
        // пароли схлопывались бы в одну запись
        const sameKey = (a, b) =>
          a.kind === b.kind && Boolean(a.cipher || a.text) && (a.cipher || a.text) === (b.cipher || b.text);
        const dedup = prev.filter((p) => !sameKey(p, item));
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
      format: 1,
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
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('это не файл резервной копии ZSpeakly');
      }
      if (payload.app && payload.app !== 'ZSpeakly') {
        throw new Error(`копия от другого приложения: ${String(payload.app).slice(0, 40)}`);
      }
      const lists = ['dictations', 'dictionary', 'snippets', 'voiceHotkeys', 'presets', 'instructions'];
      const hasList = lists.some((k) => Array.isArray(payload[k]));
      const hasSettings = payload.settings && typeof payload.settings === 'object';
      if (!hasList && !hasSettings) throw new Error('в файле нет данных ZSpeakly');

      // файл мог быть собран руками или другой версией: мусорные строки
      // не должны ронять список на первом же рендере
      const cleanDictations = (list) =>
        list
          .filter((d) => d && typeof d.text === 'string' && d.text.trim())
          .map((d, i) => ({
            id: String(d.id || `d-import-${Date.now()}-${i}`),
            text: String(d.text).slice(0, 8000),
            createdAt: Number(d.createdAt) || Date.now(),
            durationMs: Number(d.durationMs) || 0,
            words: Number(d.words) || String(d.text).trim().split(/\s+/).length,
            language: typeof d.language === 'string' ? d.language : undefined,
            source: d.source === 'dictation' ? 'dictation' : 'import',
          }));
      const cleanDictionary = (list) =>
        list
          .filter((w) => w && typeof w.word === 'string' && w.word.trim())
          .map((w, i) => ({
            id: String(w.id || `w-import-${Date.now()}-${i}`),
            word: String(w.word).trim().slice(0, 60),
            pronunciation: String(w.pronunciation || '').trim().slice(0, 60),
            createdAt: Number(w.createdAt) || Date.now(),
          }));

      const applied = [];
      if (hasSettings) {
        setSettings({ ...DEFAULT_SETTINGS, ...payload.settings });
        applied.push('настройки');
      }
      if (Array.isArray(payload.dictations)) {
        const clean = cleanDictations(payload.dictations);
        setDictations(clean);
        applied.push(`диктовки (${clean.length})`);
      }
      if (Array.isArray(payload.dictionary)) {
        const clean = cleanDictionary(payload.dictionary);
        setDictionary(clean);
        applied.push(`словарь (${clean.length})`);
      }
      if (Array.isArray(payload.snippets)) {
        const clean = sanitizeSnippets(payload.snippets);
        setSnippets(clean);
        applied.push(`быстрые блоки (${clean.length})`);
      }
      if (Array.isArray(payload.voiceHotkeys)) {
        setVoiceHotkeys(payload.voiceHotkeys);
        applied.push('голосовые сочетания');
      }
      if (Array.isArray(payload.presets)) {
        setPresets(payload.presets);
        applied.push(`AI-инструкции (${payload.presets.length})`);
      }
      if (Array.isArray(payload.instructions)) {
        setInstructions(payload.instructions);
        applied.push(`свои инструкции (${payload.instructions.length})`);
      }
      if (payload.stats && typeof payload.stats === 'object') {
        setStats({ ...DEFAULT_STATS, ...payload.stats });
        applied.push('счётчики');
      }
      if (payload.profile && typeof payload.profile === 'object') {
        setProfile({ name: String(payload.profile.name || '').slice(0, 40) });
        applied.push('профиль');
      }
      return applied;
    },
    [setSettings, setDictations, setDictionary, setVoiceHotkeys, setPresets, setInstructions, setStats, setProfile],
  );

  const value = useMemo(
    () => ({
      settings,
      updateSettings,
      dictations,
      addDictation,
      deleteDictation,
      updateDictation,
      clearDictations,
      dictionary,
      addDictionaryWord,
      removeDictionaryWord,
      toggleDictionaryPin,
      noteDictionaryUsage,
      snippets,
      addSnippet,
      removeSnippet,
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
      settings, updateSettings, dictations, addDictation, deleteDictation, updateDictation, clearDictations,
      dictionary,
      addDictionaryWord,
      removeDictionaryWord,
      toggleDictionaryPin,
      noteDictionaryUsage,
      snippets,
      addSnippet,
      removeSnippet,
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
