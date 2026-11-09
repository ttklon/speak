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

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
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
    };
  }, [open, onClose]);

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
        style={{ width }}
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
