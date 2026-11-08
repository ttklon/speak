import { describe, expect, it } from 'vitest';
import { buildSummary, keySentences, summarizeTranscript } from './ai/summarizer.js';

const TRANSCRIPT = `Сегодня мы обсудили статус релиза и сроки выкладки.
Команда подготовила смету на квартал и согласовала бюджет с клиентом.
Решили перенести демонстрацию на пятницу, чтобы успеть проверить все сценарии.
Нужно отправить письмо клиенту до среды и приложить обновлённую смету.
Проверить, что бэкап базы данных делается ежедневно.
В остальном всё идёт по плану, рисков нет.`;

describe('summarizer', () => {
  it('выделяет ключевые предложения не больше лимита', () => {
    const key = keySentences(TRANSCRIPT, 3);
    expect(key.length).toBe(3);
    key.forEach((s) => expect(TRANSCRIPT).toContain(s));
  });

  it('находит решения и задачи', () => {
    const { summary, decisions, tasks } = buildSummary(TRANSCRIPT);
    expect(decisions.length).toBeGreaterThan(0);
    expect(tasks.length).toBeGreaterThan(0);
    expect(summary).toContain('**Кратко**');
    expect(summary).toContain('☐');
  });

  it('пустой текст даёт пустое резюме', () => {
    expect(buildSummary('').summary).toBe('');
  });

  it('summarizeTranscript работает офлайн', async () => {
    const res = await summarizeTranscript(TRANSCRIPT, { aiProcessing: false });
    expect(res.engine).toBe('offline');
    expect(res.summary.length).toBeGreaterThan(30);
    expect(res.tasks[0]).toHaveProperty('done', false);
  });
});
