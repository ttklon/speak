import { describe, expect, it } from 'vitest';
import {
  APP_PROFILE_LIMITS,
  describeAppProfile,
  languageForTarget,
  matchAppProfile,
  normalizeMatch,
  sanitizeAppProfiles,
} from './appProfiles.js';

const rules = [
  { id: 'a', match: 'Telegram', language: 'ru' },
  { id: 'b', match: 'visual studio code', language: 'en' },
];

describe('профиль под активное окно', () => {
  it('совпадает по имени программы без учёта регистра и .exe', () => {
    expect(matchAppProfile({ app: 'telegram', title: 'Telegram' }, rules)?.language).toBe('ru');
    expect(matchAppProfile({ app: 'Telegram', title: 'Чат' }, rules)?.id).toBe('a');
  });

  it('совпадает по части заголовка', () => {
    const rule = matchAppProfile({ app: 'Code', title: 'main.js — Visual Studio Code' }, rules);
    expect(rule?.language).toBe('en');
  });

  it('имя программы важнее заголовка: Slack в заголовке браузера не перебьёт Code', () => {
    const mixed = [
      { id: 'slack', match: 'slack', language: 'en' },
      { id: 'code', match: 'visual studio code', language: 'en' },
    ];
    expect(matchAppProfile({ app: 'chrome', title: 'Slack | Visual Studio Code' }, mixed)?.id).toBe('slack');
  });

  it('без правила остаётся общий язык настроек', () => {
    expect(languageForTarget({ app: 'notepad', title: 'Без имени' }, rules, 'ru')).toBe('ru');
    expect(languageForTarget({}, rules, 'en')).toBe('en');
    expect(matchAppProfile({ app: 'notepad' }, rules)).toBeNull();
  });

  it('своё окно не получает чужой профиль', () => {
    expect(matchAppProfile({ own: true, app: 'Telegram' }, rules)).toBeNull();
  });

  it('битые правила не ломают разбор', () => {
    expect(matchAppProfile({ app: 'Telegram' }, [{ match: 'Telegram', language: 'xx' }])).toBeNull();
    expect(matchAppProfile({ app: 'Telegram' }, [{ match: '   ', language: 'ru' }])).toBeNull();
    expect(matchAppProfile({ app: 'Telegram' }, null)).toBeNull();
  });

  it('очистка правил: известные языки, без дублей, с пределом', () => {
    const clean = sanitizeAppProfiles([
      { match: ' Telegram ', language: 'en' },
      { match: 'telegram', language: 'ru' },
      { match: 'Code', language: 'en' },
      { match: '', language: 'ru' },
      { match: 'Word', language: 'de' },
      null,
    ]);
    expect(clean.map((r) => r.match)).toEqual(['Telegram', 'Code', 'Word']);
    expect(clean[0].language).toBe('en');
    const many = sanitizeAppProfiles(
      Array.from({ length: APP_PROFILE_LIMITS.rules + 4 }, (_, i) => ({ match: `app${i}`, language: 'ru' })),
    );
    expect(many).toHaveLength(APP_PROFILE_LIMITS.rules);
  });

  it('нормализация убирает .exe и лишние пробелы', () => {
    expect(normalizeMatch('  Visual   Studio CODE.exe ')).toBe('visual studio code');
  });

  it('подпись правила говорит словами человека', () => {
    expect(describeAppProfile({ match: 'Telegram', language: 'en' })).toBe('Telegram → Английский');
  });
});
