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
        push({
          title: where === 'failed' ? 'Готово, но вставить не удалось' : `Готово: ${instruction.title}`,
          description: [truncate(result, 90), note].filter(Boolean).join(' — '),
          tone: where === 'failed' || note ? 'warn' : 'success',
        });
      } catch (err) {
        push({ title: 'Инструкция не выполнилась', description: String(err?.message || err), tone: 'warn' });
      } finally {
        if (mounted.current) setBusy(null);
      }
    },
    [push, settings, dictations],
  );

  return { run, busy };
}

export default useTextAction;
