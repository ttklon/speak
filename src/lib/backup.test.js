import { describe, expect, it } from 'vitest';
import { BACKUP_MAX_BYTES, prepareBackup, readBackupJsonFile } from './backup.js';
import { DICTATION_MAX_ITEMS } from './dictationBudget.js';

describe('подготовка резервной копии', () => {
  it('сохраняет длинную историю, происхождение и статистику словаря', () => {
    const text = 'Юникод 😀\n'.repeat(1200);
    const rawText = 'исходный 😀\n'.repeat(90).trim();
    const input = { app: 'ZSpeakly', dictations: [
      { id: 'f', text, rawText, source: 'file', fileName: 'встреча.wav', sttModel: 'small-q5_1', sttParts: 3 },
      { id: 'c', text: 'ответ', source: 'command', command: 'сократи' },
    ], dictionary: [{ id: 'w', word: 'Слово', pronunciation: 'слово', pinned: true, hits: 7, lastUsedAt: 123 }] };
    const result = prepareBackup(input);
    expect(result.dictations[0]).toMatchObject({ id: 'f', text, rawText, source: 'file', fileName: 'встреча.wav', sttModel: 'small-q5_1', sttParts: 3 });
    expect(result.dictations[1]).toMatchObject({ source: 'command', command: 'сократи' });
    expect(result.dictionary[0]).toMatchObject(input.dictionary[0]);
  });

  it('не принимает неподходящий раздел и не подготавливает частичное восстановление', () => {
    for (const payload of [
      { settings: {}, presets: [null] },
      { dictations: [{ text: 'да' }], dictionary: 'сломано' },
      { dictations: [{ text: 'да', sttModel: {} }] },
      { settings: { aiEndpoint: { broken: true } } },
      { voiceHotkeys: [{ id: 'диктовка', keys: 'Ctrl' }] },
      { instructions: [{ title: 'тест', prompt: {} }] },
    ]) expect(() => prepareBackup(payload)).toThrow();
  });

  it('не допускает повреждённые идентификаторы и скрытую обрезку правил приложений', () => {
    for (const profile of [
      { id: { unsafe: true }, match: 'Code', language: 'ru' },
      { id: 'id', match: 'я'.repeat(41), language: 'ru' },
      { id: 'id', match: { value: 'Code' }, language: 'ru' },
    ]) expect(() => prepareBackup({ settings: { appProfiles: [profile] } })).toThrow();
    expect(() => prepareBackup({ settings: { appProfiles: [
      { id: 'dup', match: 'Code', language: 'ru' },
      { id: 'dup', match: 'Word', language: 'en' },
    ] } })).toThrow();
  });

  it('не допускает совпадений идентификаторов быстрых блоков и правил после нормализации', () => {
    expect(() => prepareBackup({ snippets: [
      { id: 'same', trigger: 'один', body: 'текст 1' },
      { id: 'same', trigger: 'два', body: 'текст 2' },
    ] })).toThrow();
    expect(() => prepareBackup({ snippets: [{ id: { broken: true }, trigger: 'один', body: 'текст' }] })).toThrow();
    expect(() => prepareBackup({ settings: { appProfiles: [
      { id: 'app-2', match: 'Code', language: 'ru' },
      { match: 'Word', language: 'en' },
    ] } })).toThrow();
  });

  it('сохраняет неизвестные настройки и маркеры миграции для совместимости', () => {
    const settings = { speedFix151: true, modelTiers165: true, legacyOption: 'значение' };
    expect(prepareBackup({ settings }).settings).toMatchObject(settings);
  });

  it('отклоняет зарезервированные ключи объекта настроек без загрязнения прототипа', () => {
    const settings = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(() => prepareBackup({ settings })).toThrow();
    expect(({}).polluted).toBeUndefined();
  });

  it('не обрезает незаметно историю сверх текущего бюджета', () => {
    const records = Array.from({ length: DICTATION_MAX_ITEMS + 1 }, (_, i) => ({ id: `d-${i}`, text: 'слово' }));
    expect(() => prepareBackup({ dictations: records })).toThrow(/лимит/i);
  });

  it('разрешает пустые списки и частичный старый формат, но не чужой или пустой файл', () => {
    expect(prepareBackup({ dictations: [], dictionary: [] })).toMatchObject({ dictations: [], dictionary: [] });
    expect(() => prepareBackup({})).toThrow();
    expect(() => prepareBackup({ app: 'другая программа', dictations: [] })).toThrow();
  });
});

describe('ограничение файла резервной копии', () => {
  it('не читает файл свыше лимита', async () => {
    let read = false;
    const file = { size: BACKUP_MAX_BYTES + 1, text: async () => { read = true; return '{}'; } };
    await expect(readBackupJsonFile(file)).rejects.toThrow(/размер|больше/i);
    expect(read).toBe(false);
  });

  it('принимает граничный размер и не раскрывает фрагменты ошибочного JSON', async () => {
    expect(await readBackupJsonFile({ size: BACKUP_MAX_BYTES, text: async () => '{"dictations":[]}' })).toEqual({ dictations: [] });
    await expect(readBackupJsonFile({ size: 13, text: async () => '{секрет' })).rejects.toThrow(/не JSON/i);
  });

  it('читает UTF-8 и отклоняет пустой JSON без содержимого в ошибке', async () => {
    const file = new File(['{"имя":"ёж 🦔"}'], 'unicode.json', { type: 'application/json' });
    // jsdom не реализует File.text; размер остаётся фактическим числом байтов UTF-8.
    expect(file.size).toBe(new TextEncoder().encode('{"имя":"ёж 🦔"}').length);
    expect(await readBackupJsonFile({ size: file.size, text: async () => '{"имя":"ёж 🦔"}' })).toEqual({ имя: 'ёж 🦔' });
    await expect(readBackupJsonFile({ size: 0, text: async () => '' })).rejects.toThrow(/не JSON/i);
  });

  it('отклоняет неизвестный размер, не читая файл', async () => {
    let read = false;
    const file = { size: NaN, text: async () => { read = true; return '{}'; } };
    await expect(readBackupJsonFile(file)).rejects.toThrow(/размер/i);
    expect(read).toBe(false);
  });
});
