import { describe, it, expect, vi, beforeEach } from 'vitest';

const llmRewrite = vi.fn();
vi.mock('./ai/textops.js', () => ({ llmRewrite: (...args) => llmRewrite(...args) }));

const { offlineTranslate, translate } = await import('./translate.js');

beforeEach(() => llmRewrite.mockReset());

describe('офлайн-перевод по словарю', () => {
  it('переводит частые слова и фразы, сохраняя регистр', () => {
    const r = offlineTranslate('Привет, команда! Как дела?');
    expect(r.engine).toBe('offline');
    expect(r.text).toBe('Hello, team! How are you?');
  });

  it('сохраняет числа и порядок, не склеивает знаки', () => {
    const r = offlineTranslate('Задача 42: срок 5 дней');
    expect(r.text).toContain('42');
    expect(r.text).toMatch(/task/i);
    expect(r.text).not.toMatch(/\s+[,.;:!?]/);
  });

  it('незнакомые слова не выбрасывает, а оставляет как есть', () => {
    const r = offlineTranslate('Привет, это тест на абракадабру');
    expect(r.text).toMatch(/hello/i);
    expect(r.text).toContain('абракадабру');
    expect(r.coverage).toBeLessThan(100);
    expect(r.note).toMatch(/локальную модель/);
  });

  it('ё и кавычки не мешают узнавать слова', () => {
    const r = offlineTranslate('«Всё готово»');
    expect(r.text).toBe('«All done»');
    expect(r.coverage).toBe(100);
    expect(r.note).toBe('');
  });

  it('обратное направление тоже работает', () => {
    expect(offlineTranslate('Good morning team', 'en', 'ru').text).toBe('Доброе утро команда');
  });

  it('неподдержанное направление честно говорит об этом и текст не теряет', () => {
    const r = offlineTranslate('Привет', 'ru', 'ja');
    expect(r.text).toBe('Привет');
    expect(r.note).toMatch(/не поддержано/);
  });

  it('пустой ввод не роняет', () => {
    expect(offlineTranslate('').text).toBe('');
    expect(offlineTranslate(null).text).toBe('');
  });
});

describe('перевод с локальной моделью', () => {
  it('без включённого ИИ идёт офлайн-словарь', async () => {
    const r = await translate('Привет', { settings: { aiProcessing: false } });
    expect(r.engine).toBe('offline');
    expect(llmRewrite).not.toHaveBeenCalled();
  });

  it('включённый ИИ переводит и отдаёт engine=llm', async () => {
    llmRewrite.mockResolvedValue('Hello there');
    const r = await translate('Привет', {
      settings: { aiProcessing: true, aiEndpoint: 'http://localhost:11434', aiModel: 'qwen' },
    });
    expect(r).toEqual({ text: 'Hello there', engine: 'llm' });
    expect(llmRewrite.mock.calls[0][0]).toMatchObject({ endpoint: 'http://localhost:11434', model: 'qwen' });
  });

  it('если модель не ответила — тихо откатывается на словарь', async () => {
    llmRewrite.mockResolvedValue('');
    const r = await translate('Привет', {
      settings: { aiProcessing: true, aiEndpoint: 'http://localhost:11434' },
    });
    expect(r.engine).toBe('offline');
    expect(r.text).toBe('Hello');
  });

  it('пустой текст не отправляется в модель', async () => {
    const r = await translate('   ', { settings: { aiProcessing: true, aiEndpoint: 'http://x' } });
    expect(r).toEqual({ text: '', engine: 'offline' });
    expect(llmRewrite).not.toHaveBeenCalled();
  });
});
