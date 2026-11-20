import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * Модалка в стиле видео: оверлей rgba(0,0,0,.55) + blur, карточка #262628,
 * заголовок 16–18pt, кнопка закрытия справа сверху.
 */
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

  useEffect(() => {
    if (!open) return undefined;
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
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current?.();
        return;
      }
      // Tab не должен уходить в приложение за модалкой: иначе фокус
      // «теряется» и клавиатурой пользоваться невозможно
      if (e.key === 'Tab') {
        const list = focusables();
        if (!list.length) return;
        const first = list[0];
        const last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const t = setTimeout(() => {
      const target =
        ref.current?.querySelector('[data-autofocus]') ||
        ref.current?.querySelector('input, textarea');
      target?.focus?.();
      if (target?.select && target.tagName === 'INPUT') target.select();
    }, 60);
    return () => {
      document.removeEventListener('keydown', onKey);
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
