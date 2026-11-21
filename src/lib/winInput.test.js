import { describe, expect, it, vi } from 'vitest';
// Модуль живёт в main-процессе (CommonJS) — проверяем его как есть.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  findCompiler,
  candidateCompilers,
  helperPaths,
  parseHelperOutput,
  createWinInput,
  HELPER_SOURCE,
} = require('../../electron/winInput.cjs');

describe('поиск компилятора C#', () => {
  it('перебирает Framework64 и Framework, начиная с 4.0', () => {
    const list = candidateCompilers();
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]).toMatch(/Framework64[\\/]v4\.0\.30319[\\/]csc\.exe$/);
    // x86-версия тоже в списке: на 32-битной Windows 64-й папки не будет
    expect(list.some((p) => /Framework[\\/]v4\.0\.30319/.test(p))).toBe(true);
  });

  it('возвращает первый существующий путь', () => {
    const wanted = candidateCompilers()[1];
    expect(findCompiler((p) => p === wanted)).toBe(wanted);
  });

  it('без компилятора возвращает пустую строку, а не падает', () => {
    expect(findCompiler(() => false)).toBe('');
  });
});

describe('разбор ответа помощника', () => {
  it('читает JSON из последней строки', () => {
    expect(parseHelperOutput('мусор\n{"ok":true,"typed":3,"total":3}')).toMatchObject({
      ok: true,
      typed: 3,
    });
  });

  it('на пустой ответ говорит, что ответа нет', () => {
    expect(parseHelperOutput('')).toMatchObject({ ok: false });
    expect(parseHelperOutput('   ').reason).toMatch(/нет ответа/);
  });

  it('на не-JSON не делает вид, что всё хорошо', () => {
    const parsed = parseHelperOutput('Unhandled exception: ...');
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toMatch(/непонятный ответ/);
  });
});

describe('честный отказ вне Windows', () => {
  it('на другой ОС помощник не «готов», и причина названа', async () => {
    const input = createWinInput({ platform: 'linux', baseDir: '/tmp/zs-test' });
    const state = await input.ensure();
    expect(state.ready).toBe(false);
    expect(state.reason).toMatch(/только в Windows/);
  });

  it('без собранного exe тип и вставка не врут об успехе', async () => {
    const input = createWinInput({ platform: 'win32', baseDir: '/tmp/zs-test-none', exists: () => false });
    const typed = await input.type('привет');
    expect(typed.ok).toBe(false);
    expect(typed.reason).toMatch(/не собран|только Windows/);
    const pasted = await input.paste();
    expect(pasted.ok).toBe(false);
  });

  it('путь помощника лежит в папке приложения, а не рядом с программой', () => {
    const paths = helperPaths('/data/zspeakly');
    expect(paths.exe.endsWith('zs-input.exe')).toBe(true);
    expect(paths.dir).toContain('zspeakly');
  });

  it('состояние всегда содержит платформу и причину', async () => {
    const input = createWinInput({ platform: 'linux', baseDir: '/tmp/zs-test' });
    const state = input.status();
    expect(state.platform).toBe('linux');
    expect(typeof state.reason).toBe('string');
  });
});

describe('исходник помощника (собрать C# здесь нельзя — проверяем структуру)', () => {
  it('зовёт SendInput с UNICODE и скан-кодами', () => {
    expect(HELPER_SOURCE).toMatch(/SendInput\(/);
    expect(HELPER_SOURCE).toMatch(/KEYEVENTF_UNICODE/);
    // Ctrl+V скан-кодом: не зависит от раскладки
    expect(HELPER_SOURCE).toMatch(/VK_V/);
    expect(HELPER_SOURCE).toMatch(/VK_CONTROL/);
  });

  it('умеет стирать вставленное: Backspace ровно N раз', () => {
    // «Отмени» стирает по символу: при наборе SendInput Ctrl+Z снял бы
    // только последнюю букву, а Backspace убирает весь вставленный хвост
    expect(HELPER_SOURCE).toMatch(/VK_BACK/);
    expect(HELPER_SOURCE).toMatch(/command == "erase"/);
    expect(HELPER_SOURCE).toMatch(/static int Erase\(int count\)/);
  });

  it('умеет Enter и Tab как настоящие клавиши', () => {
    expect(HELPER_SOURCE).toMatch(/VK_RETURN/);
    expect(HELPER_SOURCE).toMatch(/VK_TAB/);
  });

  it('не использует синтаксис новее C# 5 — csc.exe из .NET Framework его не поймёт', () => {
    expect(HELPER_SOURCE).not.toMatch(/\$"/); // интерполяция строк
    expect(HELPER_SOURCE).not.toMatch(/\bnameof\s*\(/);
    expect(HELPER_SOURCE).not.toMatch(/\?\./); // null-conditional
    expect(HELPER_SOURCE).not.toMatch(/=>\s*[^;]+;/); // expression-bodied члены
    expect(HELPER_SOURCE).not.toMatch(/\bvar\b/); // допустим, но пусть будет явно
  });

  it('фигурные скобки сбалансированы — иначе компилятор упадёт молча', () => {
    const open = (HELPER_SOURCE.match(/{/g) || []).length;
    const close = (HELPER_SOURCE.match(/}/g) || []).length;
    expect(open).toBe(close);
    expect(open).toBeGreaterThan(20);
  });

  it('пишет результат в stdout одной строкой JSON и возвращает код выхода', () => {
    expect(HELPER_SOURCE).toMatch(/Console\.WriteLine/);
    expect(HELPER_SOURCE).toMatch(/return 0;/);
    expect(HELPER_SOURCE).toMatch(/return complete \? 0 : 1;/);
    // ответ должен быть валидным JSON-экранированием
    expect(HELPER_SOURCE).toMatch(/sb\.Append\('\\\\'\)/);
  });
});
