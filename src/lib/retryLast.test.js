import { describe, expect, it } from 'vitest';
import { retryAvailability, shouldReplaceText } from './retryLast.js';

describe('shouldReplaceText', () => {
  it('заменяет, когда точный проход услышал больше слов', () => {
    const res = shouldReplaceText('проверка диктовки раз два', 'проверка диктовки раз два три');
    expect(res.replace).toBe(true);
    expect(res.note).toContain('стало 5');
  });

  it('не подменяет текст на тот же самый', () => {
    expect(shouldReplaceText('Привет, мир.', 'привет,  мир.').replace).toBe(false);
  });

  it('не подменяет на пустоту', () => {
    expect(shouldReplaceText('Привет, мир.', '   ').replace).toBe(false);
  });

  it('не подменяет, когда слов стало меньше', () => {
    const res = shouldReplaceText('раз два три четыре', 'раз два');
    expect(res.replace).toBe(false);
    expect(res.note).toContain('меньше');
  });

  it('при равном числе слов разные слова не считаются улучшением', () => {
    const res = shouldReplaceText('пойдём в кино', 'пойдём на каток');
    expect(res.replace).toBe(false);
    expect(res.note).toContain('не больше');
  });

  it('при равном числе слов знак в конце — улучшение', () => {
    expect(shouldReplaceText('привет как дела', 'Привет, как дела?').replace).toBe(true);
  });

  it.each([
    ['Не отправляйте отчёт', 'Отправляйте отчёт завтра утром.'],
    ['Отправляйте отчёт', 'Не отправляйте отчёт завтра.'],
    ['Не включайте двигатель', 'Можно включить двигатель.'],
    ['Цена 100 рублей', 'Цена 10 рублей и доставка.'],
    ['Купи 1,5 кг', 'Купи 1.5 кг сегодня.'],
    ['Цена 100%', 'Цена 100 единиц.'],
    ['Значение -5', 'Значение 5 единиц.'],
    ['Сначала один потом два', 'Потом два сначала один пожалуйста.'],
    ['Он готов', 'Она готова.'],
    ['Нажать кнопку', 'Нажать не кнопку а рычаг.'],
    ["The service is ready", "The service is isn't ready yet."],
    ['Код B2B API', 'Код B3B API готов.'],
    ['Цена 100 ₽', 'Цена 100 $ сегодня.'],
    ['Алло алло друг', 'Алло друг уже здесь.'],
    ['Цена 1,5', 'Цена 1.5.'],
    ['Казнить, нельзя помиловать', 'Казнить нельзя, помиловать.'],
    ['Казнить, нельзя помиловать', 'Казнить нельзя, помиловать сегодня.'],
    ['Адрес example.com открыт', 'Адрес example com открыт сегодня.'],
    ['Адрес example.com открыт', 'Адрес example. com открыт сегодня.'],
  ])('опасное изменение «%s» → «%s» оставляет оба варианта для проверки', (before, after) => {
    expect(shouldReplaceText(before, after)).toMatchObject({ replace: false, manualReview: true });
  });

  it('добавление слов без потери исходных допускается, но это не оценка смысла', () => {
    expect(shouldReplaceText('Не нажимайте кнопку 10%', 'Не нажимайте красную кнопку 10% сейчас.').replace).toBe(true);
    expect(shouldReplaceText('Проверка диктовки раз два три', 'Проверка диктовки: раз, два, три. Четыре.').replace).toBe(true);
    expect(shouldReplaceText('Привет мир', 'Привет, мир!').replace).toBe(true);
  });

  it('считает слова, а не символы: длинный мусор не выигрывает', () => {
    expect(shouldReplaceText('раз два три', 'раз два три раз два три раз два три').replace).toBe(true);
    expect(shouldReplaceText('раз два три четыре пять', 'раза два').replace).toBe(false);
  });
});

describe('retryAvailability', () => {
  it.each([null, { pcm: [1, 2] }])('быстрый блок нельзя заменить повторной расшифровкой триггера (%s)', (audio) => {
    const res = retryAvailability({ audio, native: { transcribePcm: () => {} }, isSnippet: true });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/быстрый блок/i);
    expect(res.reason).toMatch(/триггер/i);
  });

  it('без распознавания в приложении объясняет это словами', () => {
    const res = retryAvailability({ audio: { pcm: [1, 2] }, native: null });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/в приложении/);
  });

  it('без сохранённой записи просит сказать ещё раз', () => {
    const res = retryAvailability({ audio: null, native: { transcribePcm: () => {} } });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/заново/);
  });

  it('с записью и движком разрешает переспросить', () => {
    expect(retryAvailability({ audio: { pcm: [1] }, native: { transcribePcm: () => {} } }).ok).toBe(true);
  });
});
