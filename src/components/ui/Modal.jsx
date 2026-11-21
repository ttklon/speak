import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * Модалка в стиле видео: оверлей rgba(0,0,0,.55) + blur, карточка #262628,
 * заголовок 16–18pt, кнопка закрытия справа сверху.
 */

/**
 * Стек открытых модалок. Диалоги бывают вложенными: подтверждение «Удалить всю
 * историю?» открывается поверх настроек. Раньше каждый диалог слушал Escape
 * сам, и одно нажатие закрывало сразу оба: настройки пропадали вместе с
 * вопросом. Теперь клавиши обрабатывает только верхний диалог, а остальные
 * молчат.
 */
const modalStack = [];
let modalSeq = 0;
export default function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 460,
  className = '',
  closeOnOverlay = true,
  hideClose = false,
  headClassName = '',
}) {
  const ref = useRef(null);
  // куда вернуть фокус, когда окно закроется
  const opener = useRef(null);
  // onClose приходит стрелкой и меняется на каждый рендер: если держать его в
  // зависимостях эффекта, эффект перезапускается при каждом вводе символа,
  // «автофокус» заново выделяет поле — и набранное затирается. Держим в ref.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // свой номер в стеке: он же признак «это верхний диалог»
  const stackId = useRef(0);
  if (stackId.current === 0) {
    modalSeq += 1;
    stackId.current = modalSeq;
  }

  useEffect(() => {
    if (!open) return undefined;
    const id = stackId.current;
    modalStack.push(id);
    try {
      opener.current = document.activeElement;
    } catch {
      opener.current = null;
    }
    const focusables = () =>
      [...(ref.current?.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) || [])].filter((el) => el.offsetParent !== null || el === document.activeElement);
    const onKey = (e) => {
      // слушает только верхний диалог: иначе Escape закрывал и подтверждение,
      // и окно под ним
      if (modalStack[modalStack.length - 1] !== id) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current?.();
        return;
      }
      // Tab не должен уходить в приложение за модалкой: иначе фокус
      // «теряется» и клавиатурой пользоваться невозможно. Раньше ловились
      // только края списка, и в вложенном диалоге («Удалить всю историю?»
      // поверх настроек) Tab уходил на кнопки настроек под ним. Теперь фокус
      // переставляем сами — всегда и только внутри верхнего диалога.
      if (e.key === 'Tab') {
        const list = focusables();
        if (!list.length) return;
        e.preventDefault();
        const index = list.indexOf(document.activeElement);
        const next = e.shiftKey
          ? list[index <= 0 ? list.length - 1 : index - 1]
          : list[index === -1 || index === list.length - 1 ? 0 : index + 1];
        next?.focus?.();
        return;
      }
    };
    document.addEventListener('keydown', onKey);
    const t = setTimeout(() => {
      const target =
        ref.current?.querySelector('[data-autofocus]') ||
        ref.current?.querySelector('input, textarea');
      // У подтверждения нет полей ввода: без этого фокус оставался на кнопке
      // в окне под диалогом, и Tab уводил туда же.
      (target || ref.current)?.focus?.();
      if (target?.select && target.tagName === 'INPUT') target.select();
    }, 60);
    return () => {
      document.removeEventListener('keydown', onKey);
      const at = modalStack.lastIndexOf(id);
      if (at >= 0) modalStack.splice(at, 1);
      clearTimeout(t);
      // возвращаем фокус туда, откуда окно открыли
      try {
        if (opener.current && document.contains(opener.current)) opener.current.focus?.();
      } catch {
        /* элемент мог исчезнуть вместе с окном */
      }
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (closeOnOverlay && e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        className={`modal ${className}`}
        /* Ширина не должна вылезать за окно: у настроек она задана числом (780),
           и в окне 760×560 половина кнопок уезжала за правый край — до неё было
           не добраться ни мышью, ни клавиатурой. Потолок ставим здесь, чтобы
           защита работала для любой модалки, а не только для настроек. */
        style={{ width, maxWidth: 'calc(100vw - 48px)', maxHeight: 'calc(100vh - 48px)' }}
        ref={ref}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={typeof title === 'string' ? title : undefined}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {(title || !hideClose) && (
          <div className={`modal__head ${headClassName}`}>
            <div className="modal__titles">
              {title ? <h2 className="modal__title">{title}</h2> : null}
              {subtitle ? <p className="modal__subtitle">{subtitle}</p> : null}
            </div>
            {!hideClose && (
              <button type="button" className="icon-btn icon-btn--sm" onClick={onClose} aria-label="Закрыть">
                <X size={14} />
              </button>
            )}
          </div>
        )}
        <div className="modal__body">{children}</div>
        {footer ? <div className="modal__footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
