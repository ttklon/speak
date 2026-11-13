import { describe, expect, it } from 'vitest';
import { OPS, llmIsDown, llmRewrite, resetLlmBackoff, runOp } from './ai/textops.js';
import { offlineTranslate, translate } from './translate.js';

describe('постобработка диктовки', () => {
  it('убирает слова-паразиты и ставит точку', () => {
    const out = OPS.clean('ну как бы привет, вот это типа тест');
    expect(out).toBe('Привет, это тест.');
  });

  it('срезает тянущиеся междометия из распознавания', () => {
    expect(OPS.clean('э-э  ну , привет   как дела')).toBe('Привет как дела.');
    expect(OPS.clean('Э, привет')).toBe('Привет.');
    expect(OPS.clean('а-а-а, понял')).toBe('Понял.');
    // слова, которые просто начинаются с этих букв, не страдают
    expect(OPS.clean('это не filler')).toBe('Это не filler.');
    expect(OPS.clean('Аня пришла')).toBe('Аня пришла.');
  });

  it('ставит тире вместо дефиса между словами', () => {
    expect(OPS.clean('я пришёл - и увидел')).toBe('Я пришёл — и увидел.');
    // дефис внутри слова не трогаем
    expect(OPS.clean('что-то пошло не так')).toBe('Что-то пошло не так.');
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

describe('локальная модель не тормозит офлайн-режим', () => {
  it('после сбоя следующие запросы не ждут таймаут', async () => {
    resetLlmBackoff();
    expect(llmIsDown()).toBe(false);
    // порт 9 закрыт: первый вызов падает быстро и включает паузу
    await llmRewrite({ endpoint: 'http://127.0.0.1:9', text: 'привет', timeout: 800 });
    expect(llmIsDown()).toBe(true);
    const started = Date.now();
    const second = await llmRewrite({ endpoint: 'http://127.0.0.1:9', text: 'привет', timeout: 800 });
    expect(second).toBe(null);
    expect(Date.now() - started).toBeLessThan(50);
    resetLlmBackoff();
    expect(llmIsDown()).toBe(false);
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

  describe('сокращение не рвёт мысль', () => {
    it('оставляет целые слова и заглавные после точки', () => {
      const out = OPS.shorten('Это длинный текст, который нужно сократить. В общем, надо короче.');
      expect(out).not.toMatch(/\bсодержи\b|\bпотомучто\b/);
      expect(out).toMatch(/^[А-ЯЁA-Z]/);
      expect(out).not.toMatch(/[,;]\s*\./);
      expect(out).not.toMatch(/[.!?]\s+[а-яё]/);
    });

    it('вырезает «воду» в начале фразы', () => {
      expect(OPS.shorten('Короче, я думаю, нам надо встретиться завтра.')).toMatch(/^Я думаю/);
    });

    it('не оставляет пустых предложений', () => {
      const out = OPS.shorten('Ну, в общем, короче, всё хорошо.');
      expect(out.replace(/\s+/g, ' ').trim()).not.toMatch(/^[,.;]/);
      expect(out.length).toBeGreaterThan(3);
    });
  });
});
