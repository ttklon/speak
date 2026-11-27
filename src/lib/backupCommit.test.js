// @vitest-environment node
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
import { rankDictionary } from './dictionary/rank.js';
const require = createRequire(import.meta.url);

describe('пакет восстановления профиля в main', () => {
  it('включает синхронные зеркала настроек и ранжированного словаря', () => {
    const { buildBackupChanges } = require('../../electron/backupCommit.cjs');
    const settings = { whisperModel: 'large', recognitionEngine: 'whisper' };
    const dictionary = [{ id: 'a', word: 'слово', hits: 5 }, { id: 'b', word: 'важное', pinned: true }];
    const changes = buildBackupChanges({ 'zs.settings': settings, 'zs.dictionary': dictionary, 'zs.dictations': [] },
      { whisperModel: 'small', recognitionEngine: 'auto' });
    expect(changes).toMatchObject({ 'zs.settings': settings, 'zs:settings': settings, 'zs.dictionary': dictionary,
      'zs:dictionary': rankDictionary(dictionary), 'zs:modelPinned': true, 'zs:autoDowngraded': false, 'zs.dictations': [] });
    expect(dictionary[0].id).toBe('a');
  });
  it('отклоняет незнакомые или неверные разделы до записи', () => {
    const { buildBackupChanges } = require('../../electron/backupCommit.cjs');
    for (const data of [{}, { 'zs.dictations': {} }, { 'zs.settings': [] }, { dangerous: true }, JSON.parse('{"__proto__":{}}')]) {
      expect(() => buildBackupChanges(data)).toThrow();
    }
  });
});
