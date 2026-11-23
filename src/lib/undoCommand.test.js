import { describe, expect, it } from 'vitest';
import {
  UNDO_PHRASES,
  isUndoCommand,
  normalizeUndoPhrase,
  undoFailureText,
} from './undoCommand.js';

describe('isUndoCommand', () => {
  it('узнаёт команду целиком', () => {
    for (const phrase of ['Отмени.', 'ОТМЕНИ!', 'отмени вставку', 'убери последнее', 'Верни как было']) {
      expect(isUndoCommand(phrase), phrase).toBe(true);
    }
  });

  it('не путает со фразой, где команда лишь часть', () => {
    for (const phrase of [
      'отмени встречу на четверг',
      'убери это из списка и пришли мне',
      'не отмени ничего',
      'отмени',
    ].slice(0, 3)) {
      expect(isUndoCommand(phrase), phrase).toBe(false);
    }
  });

  it('прощает знаки, регистр и лишние пробелы', () => {
    expect(isUndoCommand('  Отмени,   пожалуйста… ')).toBe(false);
    expect(isUndoCommand('отмени —')).toBe(true);
    expect(normalizeUndoPhrase('«Отмени!»')).toBe('отмени');
  });

  it('пустой текст командой не считается', () => {
    expect(isUndoCommand('')).toBe(false);
    expect(isUndoCommand('   ')).toBe(false);
    expect(isUndoCommand(null)).toBe(false);
  });

  it('список фраз без дублей', () => {
    expect(new Set(UNDO_PHRASES).size).toBe(UNDO_PHRASES.length);
  });
});

describe('undoFailureText', () => {
  it('объясняет безопасный отказ и ручное исправление', () => {
    const text = undoFailureText('неподтверждённая позиция курсора');
    expect(text).toMatch(/не стираю текст/i);
    expect(text).toMatch(/вручную/i);
  });

  it('объясняет просрочку словами человека, а не кодом', () => {
    const text = undoFailureText('прошло больше двух минут');
    expect(text).toMatch(/две минуты|больше двух минут/);
    expect(text).not.toMatch(/ttl/i);
  });

  it('объясняет другое окно', () => {
    expect(undoFailureText('текст был в «Telegram», сейчас «Code»')).toMatch(/окно уже другое/i);
  });

  it('объясняет «нечего убирать»', () => {
    expect(undoFailureText('нечего убирать')).toMatch(/Убирать нечего/);
  });

  it('на неизвестную причину не врёт, а показывает её', () => {
    expect(undoFailureText('что-то странное')).toContain('что-то странное');
  });
});
