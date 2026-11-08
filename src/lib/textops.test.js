import { describe, expect, it } from 'vitest';
import { OPS, runOp } from './ai/textops.js';
import { offlineTranslate, translate } from './translate.js';

describe('постобработка диктовки', () => {
  it('убирает слова-паразиты и ставит точку', () => {
    const out = OPS.clean('ну как бы привет, вот это типа тест');
    expect(out).toBe('Привет, это тест.');
  });

  it('делает формальный тон', () => {
    const out = OPS.formal('привет, скинь плиз документы');
    expect(out).toMatch(/Здравствуйте/);
    expect(out).toMatch(/направьте/i);
    expect(out).toMatch(/пожалуйста/i);
  });

  it('сокращает длинный текст', () => {
    const long =
      'Первое предложение про проект и сроки. Второе предложение про бюджет и риски. Третье предложение про команду и задачи. Четвёртое предложение про релиз.';
    const short = OPS.shorten(long);
    expect(short.length).toBeLessThan(long.length);
  });

  it('делает тезисы списком', () => {
    const out = OPS.bullets('Обсудили сроки. Согласовали бюджет. Назначили ответственных.');
    expect(out.split('\n')).toHaveLength(3);
    expect(out.startsWith('•')).toBe(true);
  });

  it('формирует поисковый запрос без вежливостей', () => {
    const q = OPS.searchQuery('найди пожалуйста мне статью про электронные подписи');
    expect(q).not.toContain('найди');
    expect(q).toContain('электронные');
  });

  it('понижает термины', () => {
    const out = OPS.lowerTerms('Проверь API и SDK');
    expect(out).toMatch(/программный интерфейс/);
    expect(out).toMatch(/набор инструментов/);
  });

  it('вытаскивает задачи из резюме', () => {
    const todos = OPS.todos('Сегодня обсудили релиз. Нужно отправить смету. Проверить бэкап базы.');
    expect(todos.length).toBeGreaterThan(0);
    expect(todos[0].done).toBe(false);
  });
});

describe('translate', () => {
  it('переводит частотные фразы офлайн', () => {
    const res = offlineTranslate('Привет, как дела?', 'ru', 'en');
    expect(res.engine).toBe('offline');
    expect(res.text.toLowerCase()).toContain('hello');
  });

  it('переводит с английского на русский', () => {
    const res = offlineTranslate('Good morning, team', 'en', 'ru');
    expect(res.text.toLowerCase()).toContain('доброе утро');
  });

  it('не падает на неизвестном направлении', () => {
    const res = offlineTranslate('Привет', 'ru', 'ja');
    expect(res.text).toBe('Привет');
    expect(res.note).toMatch(/не поддержано/i);
  });

  it('без локальной модели использует офлайн-движок', async () => {
    const res = await translate('Спасибо', { from: 'ru', to: 'en', settings: { aiProcessing: false } });
    expect(res.engine).toBe('offline');
    expect(res.text.toLowerCase()).toContain('thanks');
  });

  it('runOp возвращает офлайн-результат при выключенном ИИ', async () => {
    const res = await runOp('clean', 'ну привет как дела', { settings: { aiProcessing: false } });
    expect(res.engine).toBe('offline');
    expect(res.text).toBe('Привет как дела.');
  });
});
