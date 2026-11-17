import { describe, expect, it, vi } from 'vitest';
// Модуль живёт в main-процессе (CommonJS) — проверяем его как есть.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findCompiler, candidateCompilers, helperPaths, parseHelperOutput, createWinInput } = require(
  '../../electron/winInput.cjs',
);

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
