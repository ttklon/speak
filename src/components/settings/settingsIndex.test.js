import { describe, expect, it } from 'vitest';
import { SETTING_ENTRIES } from './settingsIndex.js';

describe('индекс настроек', () => {
  it('содержит строки из всех шести разделов', () => {
    const sections = new Set(SETTING_ENTRIES.map((e) => e.section));
    expect([...sections].sort()).toEqual([
      'about',
      'account',
      'app',
      'data',
      'diagnostics',
      'features',
      'network',
    ]);
  });

  it('находит настройки по частым запросам', () => {
    const find = (q) => SETTING_ENTRIES.filter((e) => e.title.toLowerCase().includes(q)).map((e) => e.title);
    expect(find('звук')).toContain('Звуковой отклик');
    expect(find('уведомл')).toContain('Уведомления');
    expect(find('пароли')).toContain('Скрывать пароли');
    expect(find('обновлен')).toContain('Проверять обновления на GitHub');
    expect(find('ошибки')).toContain('Отправлять ошибки и логи');
  });

  it('не содержит обрезков короче четырёх символов', () => {
    expect(SETTING_ENTRIES.every((e) => e.title.length >= 4)).toBe(true);
  });
});
