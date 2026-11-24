/**
 * AI-инструкции над выделенным текстом в любом приложении Windows.
 *
 * Сценарий из видео: пользователь выделяет текст в чужой программе, жмёт
 * Ctrl+Alt+E — ZSpeakly забирает выделение, прогоняет офлайн-инструкцию и
 * вставляет результат обратно на место.
 *
 * В Electron копирование и вставку делает main-процесс (SendKeys), в браузере
 * работаем через буфер обмена — превью остаётся полностью живым.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../../state/ToastProvider.jsx';
import { useAppData } from '../../state/AppDataProvider.jsx';
import { readSelectionText, writeSelectionText } from './selection.js';
import { runInstruction } from '../ai/instructions.js';
import { analyzeStyle, applyStyle, stylePrompt } from '../ai/style.js';
import { truncate } from '../utils.js';

/**
 * Чтение и запись выделения живут в отдельном модуле: тот же код нужен
 * командному режиму («выделил — сказал, что сделать»).
 */
const readSelection = readSelectionText;
const writeSelection = writeSelectionText;

export function useTextAction() {
  const { push } = useToast();
  const { settings, dictations } = useAppData();
  const [busy, setBusy] = useState(null);
  const mounted = useRef(true);

  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const run = useCallback(
    async (instruction) => {
      if (!instruction?.id) return;
      setBusy(instruction.id);
      try {
        const source = String(await readSelection()).trim();
        if (!source) {
          push({
            title: 'Нет выделенного текста',
            description: 'Выделите текст в любом приложении и повторите сочетание.',
            tone: 'warn',
          });
          return;
        }
        const profile = settings.useWritingStyle ? analyzeStyle(dictations) : null;
        const style = profile ? stylePrompt(profile) : '';
        const raw = await runInstruction(
          style && instruction.prompt ? { ...instruction, prompt: `${instruction.prompt} ${style}` } : instruction,
          source,
          settings,
        );
        // движок может вернуть текст с честной пометкой (частичный перевод)
        const rawText = typeof raw === 'string' ? raw : String(raw?.text || '');
        const note = typeof raw === 'object' && raw ? String(raw.note || '') : '';
        const result = profile && rawText ? applyStyle(rawText, profile) : rawText;
        if (!result || result === source) {
          push({
            title: 'Изменений нет',
            description: 'Инструкция не нашла, что поправить в этом тексте.',
            tone: 'warn',
          });
          return;
        }
        const where = await writeSelection(result);
        if (where === 'busy') {
          push({
            title: 'Другая операция с текстом ещё выполняется',
            description: ['Результат не вставлен и не скопирован. Скопируйте его вручную отсюда. Текст исчезнет при закрытии уведомления или приложения.', note].filter(Boolean).join(' '),
            recoverText: result,
            tone: 'warn', ttl: 0,
          });
          return;
        }
        if (where === 'clipboard-changed' || where === 'clipboard-changed-uncertain') {
          push({
            title: where === 'clipboard-changed' ? 'Буфер изменился до замены' : 'Не удалось подтвердить замену',
            description: [where === 'clipboard-changed'
              ? 'Буфер изменился или его состояние не удалось проверить; замена не отправлялась. Скопируйте результат отсюда до закрытия уведомления или приложения.'
              : 'Во время замены буфер изменился или его состояние не удалось проверить. В окно мог попасть другой текст. Проверьте окно перед повтором; сохраните результат отсюда до закрытия уведомления или приложения.', note].filter(Boolean).join(' '),
            recoverText: result, tone: 'warn', ttl: 0,
          });
          return;
        }
        if (where === 'copied') {
          push({
            title: 'Только копирование результата',
            description: ['Автоматическая замена не выполнялась. Проверьте буфер перед вставкой или сохраните результат отсюда до закрытия уведомления или приложения.', note].filter(Boolean).join(' '),
            recoverText: result, tone: 'warn', ttl: 0,
          });
          return;
        }
        if (where === 'uncertain' || where === 'failed') {
          push({
            title: where === 'uncertain' ? 'Не удалось подтвердить замену' : 'Не удалось заменить выделение',
            description: [
              where === 'uncertain'
                ? 'В окно мог попасть текст, в том числе другое содержимое буфера. Проверьте его перед повтором.'
                : 'Проверьте окно перед повтором; не полагайтесь на содержимое буфера.',
              'Сохраните полный результат отсюда до закрытия уведомления или приложения.', note,
            ].filter(Boolean).join(' '),
            recoverText: result, tone: 'warn', ttl: 0,
          });
          return;
        }
        push({
          title: `Готово: ${instruction.title}`,
          description: [truncate(result, 90), note].filter(Boolean).join(' — '),
          tone: note ? 'warn' : 'success',
        });
      } catch (err) {
        push({ title: err?.code === 'selection-busy' ? 'Другая операция ещё выполняется' : err?.code === 'selection-unverified' ? 'Выделение не подтверждено' : 'Инструкция не выполнилась', description: String(err?.message || err), tone: 'warn' });
      } finally {
        if (mounted.current) setBusy(null);
      }
    },
    [push, settings, dictations],
  );

  return { run, busy };
}

export default useTextAction;
