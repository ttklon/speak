import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Clipboard,
  Mic,
  Search,
  Settings,
  Square,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { buildCommands, moveSelection, searchCommands } from '../../lib/commands.js';
import { NAV } from '../../lib/config.js';
import { SETTINGS_SECTIONS } from '../../lib/settingsSections.js';
import { navigate } from '../../lib/router.js';
import { useAppData } from '../../state/AppDataProvider.jsx';
import { useToast } from '../../state/ToastProvider.jsx';
import { useDictation } from '../../state/DictationProvider.jsx';
import { writeClipboard } from '../../lib/clipboard.js';

const GROUP_ICONS = {
  Страницы: ArrowRight,
  Настройки: Settings,
  Действия: Sparkles,
  'AI-инструкции': Sparkles,
};

/**
 * Палитра команд (Ctrl+K).
 *
 * Один вход ко всему, что можно сделать: перейти на страницу, открыть нужный
 * раздел настроек, начать диктовку, скопировать последнюю фразу, очистить
 * буфер. Раньше каждая из этих вещей жила в своём месте, и человеку приходилось
 * помнить структуру приложения.
 *
 * Клавиатура важнее мыши: ↑/↓ выбирают, Enter выполняет, Esc закрывает.
 * Поля ввода внутри не нужны — это не форма, а переход.
 */
export default function CommandPalette({ open, onClose }) {
  const { presets, dictations } = useAppData();
  const { push } = useToast();
  const dictation = useDictation();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const commands = useMemo(() => {
    const actions = [
      {
        id: 'dictate',
        label: dictation?.state === 'listening' ? 'Остановить диктовку' : 'Начать диктовку',
        hint: 'Ctrl + Alt + Space',
        group: 'Действия',
      },
      { id: 'open-clipboard', label: 'Открыть буфер обмена', group: 'Действия' },
      { id: 'copy-last', label: 'Скопировать последнюю фразу', group: 'Действия' },
      { id: 'diagnostics', label: 'Проверить скорость диктовки', hint: 'Диагностика', group: 'Действия' },
      { id: 'clear-draft', label: 'Очистить недописанный текст', group: 'Действия' },
    ];
    return buildCommands({
      pages: NAV.map((item) => ({ id: item.id, label: item.label })),
      settingsSections: SETTINGS_SECTIONS,
      actions,
      presets: (presets || []).map((p) => ({ id: p.id, title: p.title })),
    });
  }, [presets, dictation?.state]);

  const results = useMemo(() => searchCommands(commands, query), [commands, query]);

  // Выбор всегда указывает на существующую строку: после смены запроса список
  // короче, и «выбрана пятая из двух» — это падение по Enter.
  useEffect(() => {
    setIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setIndex(0);
    const timer = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(timer);
  }, [open]);

  const run = useCallback(
    (command) => {
      if (!command) return;
      const { target } = command;
      onClose?.();
      if (target.kind === 'page') {
        if (target.id === 'clipboard') navigate('clipboard');
        else navigate(target.id);
        return;
      }
      if (target.kind === 'settings') {
        navigate('settings', { section: target.id });
        return;
      }
      if (target.kind === 'preset') {
        navigate('hotkeys');
        return;
      }
      // Действия
      if (target.id === 'dictate') {
        if (dictation?.state === 'listening') dictation.stop?.();
        else dictation?.start?.({ mode: 'hold' });
        return;
      }
      if (target.id === 'open-clipboard') {
        navigate('clipboard');
        return;
      }
      if (target.id === 'diagnostics') {
        navigate('settings', { section: 'diagnostics' });
        return;
      }
      if (target.id === 'copy-last') {
        const last = Array.isArray(dictations) ? dictations[0] : null;
        if (!last?.text) {
          push({
            title: 'История пуста',
            description: 'Продиктуйте фразу — потом её можно будет скопировать отсюда.',
            tone: 'warn',
          });
          return;
        }
        writeClipboard(last.text)
          .then((ok) =>
            push(
              ok === false
                ? { title: 'Не удалось скопировать', tone: 'warn' }
                : {
                    title: 'Последняя фраза скопирована',
                    description: last.text.slice(0, 80),
                    tone: 'success',
                  },
            ),
          )
          .catch(() => push({ title: 'Не удалось скопировать', tone: 'warn' }));
        return;
      }
      if (target.id === 'clear-draft') {
        navigate('home');
        dictation?.cancelProcessing?.();
        push({ title: 'Недописанный текст очищен', tone: 'info' });
      }
    },
    [dictation, dictations, onClose, push],
  );

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose?.();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setIndex((current) => moveSelection(current, 1, results.length));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setIndex((current) => moveSelection(current, -1, results.length));
      return;
    }
    if (event.key === 'Tab') {
      // Палитра — одно поле и список: Tab не должен выносить фокус в приложение
      // за оверлеем, иначе палитра «осталась», а клавиатура уже работает сзади.
      event.preventDefault();
      inputRef.current?.focus();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      run(results[index]);
    }
  };

  // Выбранная строка должна быть видна: список длиннее окна палитры.
  useEffect(() => {
    const node = listRef.current?.querySelector('.command.is-active');
    node?.scrollIntoView?.({ block: 'nearest' });
  }, [index, results]);

  if (!open) return null;

  return (
    <div className="command-overlay" role="presentation" onMouseDown={() => onClose?.()}>
      <div
        className="command"
        role="dialog"
        aria-modal="true"
        aria-label="Поиск и команды"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="command__head">
          <Search size={14} className="command__icon" />
          <input
            ref={inputRef}
            className="command__input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Что сделать? Страница, настройка, действие…"
            aria-label="Поиск по командам"
            spellCheck={false}
          />
          <button type="button" className="command__close" onClick={onClose} aria-label="Закрыть поиск">
            <X size={14} />
          </button>
        </div>

        {results.length ? (
          <ul className="command__list" ref={listRef} role="listbox" aria-label="Команды">
            {results.map((command, position) => {
              const GIcon =
                command.target.kind === 'action' && command.target.id === 'dictate'
                  ? dictation?.state === 'listening'
                    ? Square
                    : Mic
                  : command.target.kind === 'action' && command.target.id === 'open-clipboard'
                    ? Clipboard
                    : command.target.kind === 'action' && command.target.id === 'clear-draft'
                      ? Trash2
                      : GROUP_ICONS[command.group] || ArrowRight;
              return (
                <li key={command.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={position === index}
                    className={`command__row ${position === index ? 'is-active' : ''}`}
                    onMouseEnter={() => setIndex(position)}
                    onClick={() => run(command)}
                  >
                    <GIcon size={13} className="command__row-icon" />
                    <span className="command__row-label">{command.label}</span>
                    <span className="command__row-group">
                      {command.hint || command.group}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="command__empty">
            Ничего не нашлось. Попробуйте «настройки», «буфер» или «диктовка».
          </div>
        )}

        <div className="command__foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> выбрать
          </span>
          <span>
            <kbd>Enter</kbd> выполнить
          </span>
          <span>
            <kbd>Esc</kbd> закрыть
          </span>
        </div>
      </div>
    </div>
  );
}
