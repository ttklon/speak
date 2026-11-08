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
import { runInstruction } from '../ai/instructions.js';
import { analyzeStyle, stylePrompt } from '../ai/style.js';
import { truncate } from '../utils.js';

function native() {
  return typeof window !== 'undefined' ? window.zspeakly?.native : null;
}

/** Забрать выделенный текст: нативное копирование или обычный буфер. */
async function readSelection() {
  const bridge = native();
  if (bridge?.readSelection) {
    const selected = await bridge.readSelection();
    if (selected) return selected;
  }
  try {
    return await navigator.clipboard.readText();
  } catch {
    return '';
  }
}

/** Вернуть текст в активное приложение: вставка или запись в буфер. */
async function writeSelection(text) {
  const bridge = native();
  if (bridge?.replaceSelection) {
    const ok = await bridge.replaceSelection(text);
    return ok ? 'inserted' : 'failed';
  }
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}

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
        const style = settings.useWritingStyle ? stylePrompt(analyzeStyle(dictations)) : '';
        const result = await runInstruction(
          style && instruction.prompt ? { ...instruction, prompt: `${instruction.prompt} ${style}` } : instruction,
          source,
          settings,
        );
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
          description: truncate(result, 90),
          tone: where === 'failed' ? 'warn' : 'success',
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
