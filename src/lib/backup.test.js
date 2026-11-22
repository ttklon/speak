import { describe, expect, it } from 'vitest';
import { prepareBackup } from './backup.js';
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
