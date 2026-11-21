import { describe, expect, it, vi } from 'vitest';
import {
  OPS,
  cleanLines,
  dropStutter,
  llmIsDown,
  llmRewrite,
  polishDictation,
  resetLlmBackoff,
  saneRewrite,
} from './ai/textops.js';
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

describe('вторая стадия чистки диктовки моделью', () => {
  it('saneRewrite принимает правку и снимает обёртку модели', () => {
    expect(saneRewrite('привет как дела', 'Вот исправленный текст: «Привет, как дела?»')).toBe(
      'Привет, как дела?',
    );
  });

  it('saneRewrite отбрасывает пересказ, дописки и потерю чисел', () => {
    expect(saneRewrite('встречаемся в 15 30 обсудим отчёт и планы на квартал', 'Встречаемся.')).toBeNull();
    expect(saneRewrite('короткая фраза', 'Короткая фраза, а ещё я добавил от себя целый абзац текста')).toBeNull();
    expect(saneRewrite('перезвони в 12 45', 'Перезвони.')).toBeNull();
  });

  it('не допускает добавления отрицания, изменения терминов и потери повторов', () => {
    const text = 'Здорово, братан! Суперкрутой AI, SaaS, B2B проект для 100% 100% заработка.';
    expect(saneRewrite(text, 'Здорово, братан! Суперкрутой AI, SaaS, не B2B проект для 100% 100% заработка.')).toBeNull();
    expect(saneRewrite(text, 'Здорово, братан! Суперкрутой AI, Сос, B2B проект для 100% 100% заработка.')).toBeNull();
    expect(saneRewrite(text, 'Здорово, братан! Суперкрутой AI, SaaS, B2B проект для 100% заработка.')).toBeNull();
    expect(saneRewrite('Это не проект.', 'Это проект.')).toBeNull();
    expect(saneRewrite('Цена 100%', 'Цена 100')).toBeNull();
    expect(saneRewrite('Долг -5', 'Долг 5')).toBeNull();
    expect(saneRewrite('Всё готово', 'Все готово')).toBeNull();
    expect(saneRewrite('Алло, алло, приветики.', 'Алло, алло! Приветики.')).toBe('Алло, алло! Приветики.');
  });

  it('при добавлении отрицания полировка не отдаёт опасный ответ', async () => {
    resetLlmBackoff();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ response: 'Это не B2B проект.' }),
    });
    try {
      expect(await polishDictation('Это B2B проект.', {
        aiEndpoint: 'http://localhost:11434', aiDictationRewrite: true,
      })).toBeNull();
    } finally {
      fetchSpy.mockRestore();
      resetLlmBackoff();
    }
  });

  it('polishDictation молчит, пока настройка не включена', async () => {
    const out = await polishDictation('ну привет как дела', {
      aiEndpoint: 'http://localhost:11434',
      aiDictationRewrite: false,
    });
    expect(out).toBeNull();
  });

  it('polishDictation возвращает правку модели, когда она включена', async () => {
    resetLlmBackoff();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ response: 'Привет, как дела?' }),
    });
    const out = await polishDictation('привет как дела', {
      aiEndpoint: 'http://localhost:11434',
      aiModel: 'qwen2.5:0.5b',
      aiDictationRewrite: true,
    });
    expect(out).toBe('Привет, как дела?');
    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.prompt).toContain('знаки препинания');
    fetchSpy.mockRestore();
  });

  it('падение Ollama не ломает диктовку — остаются офлайн-правила', async () => {
    resetLlmBackoff();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('нет сервера'));
    const out = await polishDictation('ну привет как дела', {
      aiEndpoint: 'http://localhost:11434',
      aiDictationRewrite: true,
    });
    expect(out).toBeNull();
    fetchSpy.mockRestore();
  });
});

describe('многострочная чистка (голосовые переносы)', () => {
  it('чистит каждую строку и сохраняет переносы', () => {
    expect(cleanLines('ну привет\nкак бы дела')).toBe('Привет.\nДела.');
  });

  it('не оставляет пустых строк больше одной', () => {
    expect(cleanLines('первое\n\n\n\nвторое')).toBe('Первое.\n\nВторое.');
  });

  it('одна строка — прежнее поведение', () => {
    expect(cleanLines('ну привет как дела')).toBe(OPS.clean('ну привет как дела'));
  });
});

describe('заикание в распознанном тексте', () => {
  it('повтор служебного слова убирается', () => {
    expect(dropStutter('я я думаю это это не так')).toBe('я думаю это не так');
  });

  it('знаки между словами — это уже не заикание', () => {
    expect(dropStutter('да, да, конечно')).toBe('да, да, конечно');
  });

  it('намеренные повторы и двойное отрицание не трогаются', () => {
    expect(dropStutter('очень очень хорошо')).toBe('очень очень хорошо');
    expect(dropStutter('ну ну')).toBe('ну ну');
    expect(dropStutter('да да')).toBe('да да');
    expect(OPS.clean('это не не важно')).toBe('Это не не важно.');
    expect(OPS.clean('ни никуда')).toBe('Ни никуда.');
  });

  it('диктовка целиком: и заикание, и паразиты, и знаки', () => {
    expect(OPS.clean('ну я я думаю что это это не так')).toBe('Я думаю что это не так.');
  });

  it('пустой текст', () => {
    expect(dropStutter('')).toBe('');
    expect(dropStutter(null)).toBe('');
  });
});
