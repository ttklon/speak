import { describe, expect, it } from 'vitest';
import {
  COMMAND_LIMIT,
  buildCommands,
  moveSelection,
  scoreCommand,
  searchCommands,
} from './commands.js';

const ctx = {
  pages: [
    { id: 'home', label: 'Главная' },
    { id: 'dictionary', label: 'Словарь' },
    { id: 'hotkeys', label: 'Горячие клавиши' },
    { id: 'clipboard', label: 'Буфер обмена' },
  ],
  settingsSections: [
    { id: 'dictation', label: 'Диктовка' },
    { id: 'diagnostics', label: 'Диагностика' },
  ],
  actions: [
    { id: 'dictate', label: 'Начать диктовку', group: 'Действия', hint: 'Ctrl + Alt + Space' },
    { id: 'copy-last', label: 'Скопировать последнюю фразу', group: 'Действия' },
  ],
  presets: [{ id: 'p1', title: 'Перевести на английский' }],
};

describe('сборка команд', () => {
  it('включает страницы, разделы настроек, действия и инструкции', () => {
    const commands = buildCommands(ctx);
    const ids = commands.map((c) => c.id);
    expect(ids).toContain('page:home');
    expect(ids).toContain('settings:dictation');
    expect(ids).toContain('action:dictate');
    expect(ids).toContain('preset:p1');
    expect(commands.find((c) => c.id === 'settings:dictation').target).toEqual({
      kind: 'settings',
      id: 'dictation',
    });
  });

  it('на пустом входе даёт пустой список, а не падение', () => {
    expect(buildCommands()).toEqual([]);
    expect(buildCommands({})).toEqual([]);
  });
});

describe('ранжирование поиска', () => {
  it('точное совпадение важнее начала названия', () => {
    expect(scoreCommand({ label: 'Функции' }, 'функции')).toBe(100);
    expect(scoreCommand({ label: 'Функции диктовки' }, 'функции')).toBe(80);
  });

  it('начало слова важнее совпадения в середине', () => {
    const startWord = scoreCommand({ label: 'Горячие клавиши' }, 'клавиши');
    const inside = scoreCommand({ label: 'Мегаклавиши' }, 'клавиши');
    expect(startWord).toBeGreaterThan(inside);
  });

  it('подсказка весит меньше названия', () => {
    const byLabel = scoreCommand({ label: 'Диктовка' }, 'диктовка');
    const byHint = scoreCommand({ label: 'Запуск', hint: 'диктовка' }, 'диктовка');
    expect(byLabel).toBeGreaterThan(byHint);
  });

  it('не подходящая команда не попадает в выдачу', () => {
    expect(scoreCommand({ label: 'Буфер обмена' }, 'модель')).toBe(0);
  });

  it('ё и е не различаются — человек не обязан помнить раскладку', () => {
    expect(scoreCommand({ label: 'Настройки и ещё' }, 'еще')).toBeGreaterThan(0);
  });
});

describe('выдача поиска', () => {
  it('без запроса показывает начало списка — страницы первыми', () => {
    const result = searchCommands(buildCommands(ctx), '');
    expect(result).toHaveLength(COMMAND_LIMIT);
    expect(result[0].id).toBe('page:home');
  });

  it('по запросу «дикт» находит действие раньше страницы', () => {
    const result = searchCommands(buildCommands(ctx), 'дикт');
    expect(result[0].id).toBe('action:dictate');
  });

  it('действие важнее одноимённого раздела настроек', () => {
    // Раньше на «диктов» первым стоял раздел «Диктовка», и Enter вместо записи
    // открывал настройки. Раздел должен остаться в списке, но ниже.
    const result = searchCommands(buildCommands(ctx), 'диктов');
    expect(result[0].id).toBe('action:dictate');
    expect(result.map((c) => c.id)).toContain('settings:dictation');
  });

  it('ограничивает выдачу, а не показывает всё сразу', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, label: `Действие ${i}` }));
    expect(searchCommands(many, 'действие')).toHaveLength(COMMAND_LIMIT);
    expect(searchCommands(many, 'действие', { limit: 3 })).toHaveLength(3);
  });

  it('при равном счёте сохраняет порядок списка', () => {
    const list = [
      { id: 'first', label: 'Диктовка' },
      { id: 'second', label: 'Диктовка' },
    ];
    expect(searchCommands(list, 'диктовка').map((c) => c.id)).toEqual(['first', 'second']);
  });

  it('мусор в запросе не ломает поиск', () => {
    const commands = buildCommands(ctx);
    expect(searchCommands(commands, '   ')).toHaveLength(COMMAND_LIMIT);
    expect(searchCommands(commands, 'щщщ')).toEqual([]);
    expect(searchCommands(null, 'дом')).toEqual([]);
  });
});

describe('перемещение выбора стрелками', () => {
  it('идёт вниз и вверх', () => {
    expect(moveSelection(0, 1, 3)).toBe(1);
    expect(moveSelection(2, -1, 3)).toBe(1);
  });

  it('заворачивается по кругу, а не упирается в край', () => {
    expect(moveSelection(2, 1, 3)).toBe(0);
    expect(moveSelection(0, -1, 3)).toBe(2);
  });

  it('на пустом списке возвращает 0', () => {
    expect(moveSelection(5, 1, 0)).toBe(0);
  });
});
