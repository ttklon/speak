/**
 * Единое состояние ZSpeakly: настройки, история диктовок, словарь,
 * хоткеи, AI-пресеты, буфер обмена, сессии перевода, заметки встреч,
 * статистика и профиль. Всё сохраняется локально (localStorage / profile.json).
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
import {
  buildSeedClipboard,
  buildSeedDictations,
  SEED_DICTIONARY,
  SEED_MEETINGS,
  buildSeedSessions,
} from '../lib/seed.js';
import { uid } from '../lib/utils.js';

const AppDataContext = createContext(null);

function usePersistentState(key, initialFactory) {
  // Сид-данные вычисляем один раз: иначе список пересоздавался бы на каждом рендере.
  const initialRef = useRef(null);
  if (initialRef.current === null) {
    initialRef.current = typeof initialFactory === 'function' ? initialFactory() : initialFactory;
  }
  const initial = initialRef.current;

  const [value, setValue] = useState(() => {
    const stored = read(key);
    if (stored === null || stored === undefined) return initial;
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
  const [settings, setSettings] = usePersistentState(STORAGE_KEYS.settings, () => DEFAULT_SETTINGS);
  const [dictations, setDictations] = usePersistentState(STORAGE_KEYS.dictations, () => buildSeedDictations());
  const [dictionary, setDictionary] = usePersistentState(STORAGE_KEYS.dictionary, () => SEED_DICTIONARY);
  const [clipboard, setClipboard] = usePersistentState(STORAGE_KEYS.clipboard, () => buildSeedClipboard());
  const [voiceHotkeys, setVoiceHotkeys] = usePersistentState(STORAGE_KEYS.hotkeys, () => DEFAULT_VOICE_HOTKEYS);
  const [presets, setPresets] = usePersistentState(STORAGE_KEYS.presets, () => DEFAULT_AI_PRESETS);
  const [instructions, setInstructions] = usePersistentState(
    STORAGE_KEYS.instructions,
    () => DEFAULT_CUSTOM_INSTRUCTIONS,
  );
  const [sessions, setSessions] = usePersistentState(STORAGE_KEYS.sessions, () => buildSeedSessions());
  const [meetingNotes, setMeetingNotes] = usePersistentState(STORAGE_KEYS.meetingNotes, () => SEED_MEETINGS);
  const [stats, setStats] = usePersistentState(STORAGE_KEYS.stats, () => DEFAULT_STATS);
  const [profile, setProfile] = usePersistentState(STORAGE_KEYS.profile, () => ({
    name: 'local',
    email: 'me@zspeakly.local',
    plan: 'Free · безлимит',
    credits: 0,
  }));
  const [merged, setMerged] = useState(false);

  // Слияние настроек по умолчанию (после добавления новых полей) — один раз
  useEffect(() => {
    if (merged) return;
    setSettings((prev) => ({ ...DEFAULT_SETTINGS, ...prev }));
    setMerged(true);
  }, [merged, setSettings]);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    document.documentElement.dataset.reduceMotion = mq?.matches ? 'true' : 'false';
  }, []);

  const addDictation = useCallback(
    (item) => {
      setDictations((prev) => [item, ...prev].slice(0, 3000));
    },
    [setDictations],
  );

  const deleteDictation = useCallback(
    (id) => setDictations((prev) => prev.filter((d) => d.id !== id)),
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

  const updateSettings = useCallback(
    (patch) => setSettings((prev) => ({ ...prev, ...patch })),
    [setSettings],
  );

  const addDictionaryWord = useCallback(
    (word, pronunciation) => {
      const clean = String(word || '').trim();
      if (!clean) return null;
      const entry = {
        id: uid('dict'),
        word: clean,
        pronunciation: String(pronunciation || '').trim(),
        createdAt: Date.now(),
      };
      setDictionary((prev) => [entry, ...prev.filter((w) => w.word.toLowerCase() !== clean.toLowerCase())]);
      return entry;
    },
    [setDictionary],
  );

  const removeDictionaryWord = useCallback(
    (id) => setDictionary((prev) => prev.filter((w) => w.id !== id)),
    [setDictionary],
  );

  const addClipboardItem = useCallback(
    (item) => {
      setClipboard((prev) => {
        if (item.hidePasswords && item.kind === 'password') return prev;
        const dedup = prev.filter((p) => !(p.kind === item.kind && p.text && p.text === item.text));
        return [{ ...item, id: item.id || uid('clip'), createdAt: item.createdAt || Date.now() }, ...dedup].slice(
          0,
          settings.clipboardMaxItems || 10000,
        );
      });
    },
    [setClipboard, settings.clipboardMaxItems],
  );

  const removeClipboardItem = useCallback(
    (id) => setClipboard((prev) => prev.filter((c) => c.id !== id)),
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

  const addSession = useCallback(
    (session) => {
      setSessions((prev) => [session, ...prev]);
      setStats((s) => ({ ...s, sessions: s.sessions + 1 }));
    },
    [setSessions, setStats],
  );

  const addMeetingNote = useCallback(
    (note) => setMeetingNotes((prev) => [note, ...prev]),
    [setMeetingNotes],
  );

  const updateMeetingNote = useCallback(
    (id, patch) => setMeetingNotes((prev) => prev.map((n) => (n.id === id ? { ...n, ...patch } : n))),
    [setMeetingNotes],
  );

  const removeMeetingNote = useCallback(
    (id) => setMeetingNotes((prev) => prev.filter((n) => n.id !== id)),
    [setMeetingNotes],
  );

  const resetAll = useCallback(() => {
    setDictations([]);
    setClipboard([]);
    setDictionary([]);
    setSessions([]);
    setMeetingNotes([]);
    setInstructions([]);
    setPresets(DEFAULT_AI_PRESETS);
    setVoiceHotkeys(DEFAULT_VOICE_HOTKEYS);
    setSettings(DEFAULT_SETTINGS);
    setStats(DEFAULT_STATS);
  }, [
    setDictations, setClipboard, setDictionary, setSessions, setMeetingNotes,
    setInstructions, setPresets, setVoiceHotkeys, setSettings, setStats,
  ]);

  // Автоочистка старых записей по настройкам хранения
  useEffect(() => {
    const days = Number(settings.dictationRetentionDays || 0);
    if (!days) return;
    const cutoff = Date.now() - days * 86400000;
    setDictations((prev) => {
      const next = prev.filter((d) => d.createdAt >= cutoff);
      return next.length === prev.length ? prev : next;
    });
  }, [settings.dictationRetentionDays, setDictations]);

  const bytes = useMemo(() => storageBytes(), [dictations, clipboard, sessions, meetingNotes]);

  const value = useMemo(
    () => ({
      settings,
      updateSettings,
      dictations,
      addDictation,
      deleteDictation,
      clearDictations,
      dictionary,
      addDictionaryWord,
      removeDictionaryWord,
      clipboard,
      addClipboardItem,
      removeClipboardItem,
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
      sessions,
      addSession,
      meetingNotes,
      addMeetingNote,
      updateMeetingNote,
      removeMeetingNote,
      stats,
      recordWords,
      profile,
      setProfile,
      resetAll,
      storageSize: bytes,
    }),
    [
      settings, updateSettings, dictations, addDictation, deleteDictation, clearDictations,
      dictionary, addDictionaryWord, removeDictionaryWord, clipboard, addClipboardItem,
      removeClipboardItem, toggleClipboardPin, clearClipboard, voiceHotkeys, toggleHotkey,
      updateHotkey, resetHotkeys, presets, togglePreset, updatePresetKeys, instructions, addInstruction,
      removeInstruction, updateInstruction, sessions, addSession, meetingNotes, addMeetingNote,
      updateMeetingNote, removeMeetingNote, stats, recordWords, profile, setProfile, resetAll, bytes,
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
