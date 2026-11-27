import { describe, expect, it, vi } from 'vitest';
import { runUiTask, runUiScenario, UiTaskTimeout } from '../../scripts/e2e/ui-task.mjs';

describe('ограничение времени UI-проверки', () => {
  it('объявляет начало и успешное завершение с именем, возвращает результат', async () => {
    const log = vi.fn();
    await expect(runUiTask('диктовка', async () => 42, { timeoutMs: 100, log })).resolves.toBe(42);
    expect(log.mock.calls.map(([line]) => line)).toEqual(['▶ диктовка', '◀ диктовка (завершено)']);
  });
  it('завершает зависшую задачу ошибкой с именем, не сообщает об успехе', async () => {
    const log = vi.fn();
    await expect(runUiTask('тест зависания', () => new Promise(() => {}), { timeoutMs: 20, log })).rejects.toMatchObject({ name: 'UiTaskTimeout', message: expect.stringMatching(/тест зависания.*20/) });
    expect(log.mock.calls.map(([line]) => line)).toEqual(['▶ тест зависания']);
  });
  it('не проглатывает ошибки задачи и отменяет таймер после отказа', async () => {
    const log = vi.fn(); const err = new Error('поломка');
    await expect(runUiTask('ошибка', async () => { throw err; }, { timeoutMs: 20, log })).rejects.toBe(err);
    expect(log.mock.calls.map(([line]) => line)).toEqual(['▶ ошибка']);
  });
  it('сценарий сообщает об ошибке и продолжает после обычного отказа, но не после timeout', async () => {
    const log = vi.fn(), record = vi.fn(), next = vi.fn();
    await runUiScenario('failed', () => { throw new Error('ошибка'); }, record, { timeoutMs: 20, log });
    expect(record).toHaveBeenCalledOnce();
    const runner = async () => {
      await runUiScenario('hung', () => new Promise(() => {}), record, { timeoutMs: 20, log });
      await runUiScenario('next', next, record, { timeoutMs: 20, log });
    };
    await expect(runner()).rejects.toBeInstanceOf(UiTaskTimeout);
    expect(record).toHaveBeenCalledTimes(2);
    expect(next).not.toHaveBeenCalled();
  });
  it('отклоняет неверный timeout', async () => {
    await expect(runUiTask('x', () => {}, { timeoutMs: 0, log: () => {} })).rejects.toThrow(/timeout/i);
  });
});
