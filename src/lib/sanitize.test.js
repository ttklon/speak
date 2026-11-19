import { describe, it, expect } from 'vitest';
import {
  asList,
  sanitizeDictations,
  sanitizeDictionary,
  sanitizeClipboard,
  sanitizeHotkeys,
  mergeNewHotkeys,
  sanitizePresets,
  sanitizeInstructions,
  sanitizeStats,
} from './sanitize.js';

describe('очистка сохранённых данных', () => {
  it('не массив — отдаём запасное значение, а не падаем', () => {
    expect(sanitizeDictations('не массив', [{ id: 'x' }])).toEqual([{ id: 'x' }]);
    expect(sanitizeDictations(null)).toEqual([]);
    expect(asList(undefined, (x) => x)).toEqual([]);
  });

  it('битая запись не уносит весь список', () => {
    const items = [null, 42, { text: '   ' }, { text: 'живая запись' }, 'строка'];
    const clean = sanitizeDictations(items);
    expect(clean).toHaveLength(1);
    expect(clean[0].text).toBe('живая запись');
    expect(clean[0].id).toMatch(/^d-/);
    expect(clean[0].createdAt).toBeGreaterThan(0);
  });

  it('если нормализатор бросил исключение, остальные записи целы', () => {
    const list = ['порча', { ok: true }];
    const clean = asList(list, (x) => {
      if (x === 'порча') throw new Error('битая запись');
      return x;
    });
    expect(clean).toEqual([{ ok: true }]);
  });

  it('словарь: пустые слова выбрасываются, пробелы обрезаются', () => {
    const clean = sanitizeDictionary([{ word: '  whisper ' }, { word: '' }, { word: 7 }]);
    expect(clean).toHaveLength(1);
    expect(clean[0].word).toBe('whisper');
    expect(clean[0].id).toMatch(/^w-/);
  });

  it('буфер: текст или картинка, иначе запись не нужна', () => {
    const clean = sanitizeClipboard([
      { text: 'скопированный текст' },
      { image: 'data:image/png;base64,AAA' },
      { image: 'http://злой/сайт.png' },
      {},
      null,
    ]);
    expect(clean).toHaveLength(2);
    expect(clean[1].text).toBe('');
  });

  it('пароли из хранилища не теряются: у них шифр, а не текст', () => {
    const clean = sanitizeClipboard([
      { id: 'pw-1', kind: 'password', text: '', cipher: 'enc:AAA', encrypted: true, source: 'Bitwarden' },
      { id: 'pw-2', kind: 'password', text: '', cipher: '' },
    ]);
    expect(clean).toHaveLength(1);
    expect(clean[0]).toMatchObject({ id: 'pw-1', cipher: 'enc:AAA', kind: 'password' });
    expect(clean[0].createdAt).toBeGreaterThan(0);
  });

  it('горячие клавиши: без id или без клавиш бесполезны', () => {
    const clean = sanitizeHotkeys([
      { id: 'h1', keys: ['Ctrl', 'Q'] },
      { id: 'h2', keys: [] },
      { keys: ['Ctrl'] },
      { id: 'h3', keys: ['Ctrl', 5, null] },
    ]);
    expect(clean.map((h) => h.id)).toEqual(['h1', 'h3']);
    expect(clean[1].keys).toEqual(['Ctrl']);
    expect(clean[0].enabled).toBe(true);
    expect(sanitizeHotkeys([{ id: 'h', keys: ['A'], enabled: false }])[0].enabled).toBe(false);
  });

  it('пресеты и инструкции: пустое название — не запись', () => {
    expect(sanitizePresets([{ name: ' Работа ' }, { name: '' }])).toHaveLength(1);
    const ins = sanitizeInstructions([{ title: 'Почта' }, { title: '  ' }, { text: 'без названия' }]);
    expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ title: 'Почта', text: '' });
  });

  it('статистика: мусор превращается в нули, а не в NaN', () => {
    expect(sanitizeStats({ wordsTotal: 'abc', secondsTotal: null, sessions: undefined })).toEqual({
      wordsTotal: 0,
      secondsTotal: 0,
      sessions: 0,
    });
    expect(sanitizeStats([], { wordsTotal: 5, secondsTotal: 1, sessions: 1 })).toEqual({
      wordsTotal: 5,
      secondsTotal: 1,
      sessions: 1,
    });
    expect(sanitizeStats({ wordsTotal: 120, secondsTotal: 60, sessions: 3 }).wordsTotal).toBe(120);
  });
});

describe('новые сочетания в профиле прошлой версии', () => {
  const defaults = [
    { id: 'dictation', title: 'Диктовка', keys: ['Ctrl', 'Alt', 'Space'], enabled: true },
    { id: 'voice-command', title: 'Команда голосом', keys: ['Ctrl', 'Alt', 'C'], enabled: true },
  ];

  it('недостающее сочетание дописывается, существующие не трогаются', () => {
    const stored = [{ id: 'dictation', title: 'Диктовка', keys: ['Ctrl', 'Alt', 'Q'], enabled: false }];
    const merged = mergeNewHotkeys(stored, defaults);
    expect(merged.map((h) => h.id)).toEqual(['dictation', 'voice-command']);
    // выбор человека (другие клавиши, выключено) сохраняется
    expect(merged[0].keys).toEqual(['Ctrl', 'Alt', 'Q']);
    expect(merged[0].enabled).toBe(false);
  });

  it('когда всё уже есть — список не меняется и не дублируется', () => {
    const stored = defaults.map((h) => ({ ...h }));
    expect(mergeNewHotkeys(stored, defaults)).toHaveLength(2);
  });

  it('мусор вместо списка не ломает загрузку', () => {
    expect(mergeNewHotkeys(null, defaults)).toHaveLength(2);
    expect(mergeNewHotkeys([null, 'x'], defaults).filter(Boolean)).toHaveLength(2);
    expect(mergeNewHotkeys([], [])).toEqual([]);
  });
});
