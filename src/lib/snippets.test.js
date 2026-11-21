import { describe, expect, it } from 'vitest';
import { SNIPPET_LIMITS, expandSnippet, matchSnippet, normalizePhrase, sanitizeSnippets } from './snippets.js';

const signature = { id: 's1', trigger: 'моя подпись', body: 'С уважением,\nИван Петров\n+7 900 000-00-00' };

describe('быстрые блоки', () => {
  it('сказал триггер целиком — вставился блок', () => {
    const out = expandSnippet('Моя подпись.', [signature]);
    expect(out.text).toBe(signature.body);
    expect(out.snippet.id).toBe('s1');
  });

  it('«ё» и знаки препинания не мешают совпадению', () => {
    const snippet = { id: 's2', trigger: 'адрес офиса', body: 'Ленина, 5' };
    expect(matchSnippet('АДРЕС, ОФИСА!', [snippet])).toBeTruthy();
    expect(normalizePhrase('Адрес — офиса')).toBe('адрес офиса');
  });

  it('триггер внутри фразы — это обычный текст, а не команда', () => {
    const out = expandSnippet('поставь мою подпись в конце письма', [signature]);
    expect(out.text).toBe('поставь мою подпись в конце письма');
    expect(out.snippet).toBeNull();
  });

  it('лишние пробелы и регистр в триггере не создают двойников', () => {
    const list = sanitizeSnippets([
      { trigger: 'Моя   подпись', body: 'один' },
      { trigger: 'моя подпись', body: 'два' },
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].body).toBe('один');
  });

  it('пустой триггер и пустой блок отбрасываются', () => {
    const list = sanitizeSnippets([
      { trigger: '', body: 'текст' },
      { trigger: 'подпись', body: '   ' },
      { trigger: 'подпись', body: 'ок' },
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].trigger).toBe('подпись');
  });

  it('мусор вместо списка не роняет приложение', () => {
    expect(sanitizeSnippets(null)).toEqual([]);
    expect(sanitizeSnippets('строка')).toEqual([]);
    expect(sanitizeSnippets([1, null, 'x'])).toEqual([]);
  });

  it('длина ограничена: блок не превращается в документ', () => {
    const long = sanitizeSnippets([{ trigger: 'т'.repeat(200), body: 'б'.repeat(9000) }]);
    expect(long[0].trigger.length).toBe(SNIPPET_LIMITS.trigger);
    expect(long[0].body.length).toBe(SNIPPET_LIMITS.body);
  });

  it('без блоков текст не меняется, даже если это пустая строка', () => {
    expect(expandSnippet('привет', [])).toEqual({ text: 'привет', snippet: null });
    expect(expandSnippet('', [signature])).toEqual({ text: '', snippet: null });
  });

  it('блок побеждает пунктуацию: точка из фразы в тело не попадает', () => {
    const out = expandSnippet('моя подпись.', [signature]);
    expect(out.text).not.toMatch(/\.$/u);
    expect(out.text.startsWith('С уважением')).toBe(true);
  });
});
