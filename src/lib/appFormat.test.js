import { describe, expect, it } from 'vitest';
import { formatForApp, resolveAppStyle } from './appFormat.js';

describe('оформление текста под место вставки', () => {
  it('мессенджер: точка в конце убирается, вопрос и восклицание остаются', () => {
    expect(formatForApp('Привет, как дела.', 'chat')).toBe('Привет, как дела');
    expect(formatForApp('Ты придёшь?', 'chat')).toBe('Ты придёшь?');
    expect(formatForApp('Ура!', 'chat')).toBe('Ура!');
  });

  it('редактор кода: регистр, точка, отступы и пробелы не меняются', () => {
    for (const text of [
      'Добавь проверку на пустой массив.', 'Python — это язык.',
      'JSON.parse(value).', 'UserService.Create().',
      '    const foo = 1;\n    return foo;',
    ]) expect(formatForApp(text, 'code')).toBe(text);
  });

  it('письмо: заглавная и точка, если их нет', () => {
    expect(formatForApp('добрый день', 'mail')).toBe('Добрый день.');
    expect(formatForApp('Добрый день.', 'mail')).toBe('Добрый день.');
    expect(formatForApp('Вопрос?', 'mail')).toBe('Вопрос?');
  });

  it('документ: заглавная в начале, точка не добавляется', () => {
    expect(formatForApp('план на неделю', 'doc')).toBe('План на неделю');
    expect(formatForApp('План на неделю.', 'doc')).toBe('План на неделю.');
  });

  it('незнакомое окно — текст не меняется', () => {
    expect(formatForApp('Привет, как дела.', 'neutral')).toBe('Привет, как дела.');
    expect(formatForApp('добрый день', 'neutral')).toBe('добрый день');
  });

  it('лишние пробелы и пробелы у переводов строки убираются', () => {
    expect(formatForApp('привет   мир  ', 'neutral')).toBe('привет мир');
    expect(formatForApp('  первая\n  вторая  ', 'neutral')).toBe('первая\nвторая');
  });

  it('пустой текст остаётся пустым, а не превращается в точку', () => {
    expect(formatForApp('', 'mail')).toBe('');
    expect(formatForApp('   ', 'mail')).toBe('');
  });

  it('окно определяется по имени программы и по заголовку', () => {
    expect(resolveAppStyle({ app: 'Telegram Desktop', title: '' }).style).toBe('chat');
    expect(resolveAppStyle({ app: '', title: 'Slack | general' }).style).toBe('chat');
    expect(resolveAppStyle({ app: 'Code.exe', title: 'main.js — Visual Studio Code' }).style).toBe('code');
    expect(resolveAppStyle({ app: 'OUTLOOK.EXE', title: 'Входящие' }).style).toBe('mail');
    expect(resolveAppStyle({ app: 'WINWORD.EXE', title: 'Документ1' }).style).toBe('doc');
  });

  it('незнакомое и пустое окно — «как есть» с причиной', () => {
    const unknown = resolveAppStyle({ app: 'ksnip.exe', title: 'Снимок' });
    expect(unknown.style).toBe('neutral');
    expect(unknown.why).toBe('незнакомое окно');
    const empty = resolveAppStyle({});
    expect(empty.style).toBe('neutral');
    expect(empty.why).toBe('окно не определено');
  });

  it('у каждого стиля есть человеческая подпись, а не код', () => {
    for (const target of [{ app: 'Telegram' }, { app: 'Code.exe' }, { app: 'Thunderbird' }, { app: 'Notion' }, { app: 'foo' }]) {
      const { label } = resolveAppStyle(target);
      expect(label).toBeTruthy();
      expect(label).not.toMatch(/[a-z_]+_/);
    }
  });
});
