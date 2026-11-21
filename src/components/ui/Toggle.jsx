/** Тоггл 36×20 в стиле оригинала: зелёный #15C660, белый кружок. */

import { useEffect, useRef, useState } from 'react';

// Подпись строки настроек стоит рядом с тогглом отдельным блоком, поэтому без
// label скринридер слышал просто «переключатель, включён». Берём название из
// строки, в которой лежит тоггл: у настроек это .setting-row__label, у хоткеев —
// .hk-row__title. Если рядом ничего нет, подпись нужно передать явно.
const LABEL_SELECTORS = ['.setting-row__label', '.hk-row__title', '.setting-card__title', 'label'];
const ROW_SELECTORS = ['.setting-row', '.hk-row', '.setting-card', '.row'];

export default function Toggle({ checked, onChange, label, disabled = false, size = 'md' }) {
  const ref = useRef(null);
  const [derived, setDerived] = useState('');

  useEffect(() => {
    if (label || !ref.current) return;
    const button = ref.current;
    const scope =
      LABEL_SELECTORS.map((sel) => button.closest(ROW_SELECTORS.join(','))?.querySelector(sel)).find(Boolean) ||
      ROW_SELECTORS.map((sel) => button.closest(sel)?.querySelector(LABEL_SELECTORS.join(','))).find(Boolean);
    // в .setting-row__label первая строка — название, дальше идёт пояснение
    const text = (scope?.innerText || '').trim().split('\n')[0].trim();
    if (text) setDerived(text);
  }, [label]);

  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={Boolean(checked)}
      aria-label={label || derived || undefined}
      disabled={disabled}
      className={`toggle toggle--${size} ${checked ? 'is-on' : ''} ${disabled ? 'is-disabled' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onChange?.(!checked);
      }}
    >
      <span className="toggle__knob" />
    </button>
  );
}

export { Toggle };
