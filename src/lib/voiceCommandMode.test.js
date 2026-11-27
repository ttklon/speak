import { describe, expect, it } from 'vitest';
import {
  COMMAND_ERRORS,
  COMMAND_LIMITS,
  commandInstruction,
  commandTitle,
  describeCommand,
} from './voiceCommandMode.js';

describe('командный режим: что считать командой', () => {
  it('короткая фраза становится инструкцией с исходными словами', () => {
    const instruction = commandInstruction('сократи вдвое и убери воду');
    expect(instruction).not.toBeNull();
    expect(instruction.id).toBe('voice-command');
    expect(instruction.prompt).toBe('сократи вдвое и убери воду');
  });

  it('пробелы по краям не мешают', () => {
    expect(commandInstruction('  переведи на английский \n').prompt).toBe('переведи на английский');
  });

  it('пустое и односимвольное — не команда', () => {
    expect(commandInstruction('')).toBeNull();
    expect(commandInstruction('   ')).toBeNull();
    expect(commandInstruction('а')).toBeNull();
    expect(commandInstruction(null)).toBeNull();
  });

  it('длинный пересказ не уходит в модель как команда', () => {
    const long = 'сократи '.repeat(40);
    expect(long.length).toBeGreaterThan(COMMAND_LIMITS.chars);
    expect(commandInstruction(long)).toBeNull();
  });
});

describe('командный режим: как назвать команду человеку', () => {
  it('частые просьбы узнаются по глаголу', () => {
    expect(describeCommand('сократи это')).toBe('сократить');
    expect(describeCommand('сделай короче')).toBe('сократить');
    expect(describeCommand('переведи на английский')).toBe('перевести');
    expect(describeCommand('сделай официальным')).toBe('сделать официальным');
    expect(describeCommand('разбей на пункты')).toBe('разбить на пункты');
    expect(describeCommand('исправь ошибки')).toBe('исправить ошибки');
  });

  it('незнакомая просьба остаётся своими словами', () => {
    expect(describeCommand('добавь в конце вопрос')).toBe('');
    expect(commandTitle('добавь в конце вопрос')).toBe('добавь в конце вопрос');
  });

  it('заголовок узнанной команды — её название, а не пересказ', () => {
    expect(commandTitle('сократи вдвое, убери вводные слова и канцелярит')).toBe('сократить');
  });

  it('длинная фраза в заголовке обрезается', () => {
    const title = commandTitle('перепиши так, чтобы это письмо можно было отправить клиенту без правок');
    expect(title.length).toBeLessThanOrEqual(48);
    expect(title.endsWith('…')).toBe(true);
  });

  it('пустая команда не даёт заголовка', () => {
    expect(commandTitle('')).toBe('');
  });
});

describe('командный режим: отказы объясняют, что делать', () => {
  it('нет выделения — говорим, что выделить', () => {
    expect(COMMAND_ERRORS['no-selection'].message).toMatch(/выделите/i);
  });

  it('не расслышали — подсказываем примеры', () => {
    expect(COMMAND_ERRORS['empty-command'].description).toMatch(/сократи|переведи/i);
  });
});
