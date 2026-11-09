import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Loader2 } from 'lucide-react';

export function Button({
  children,
  variant = 'ghost',
  size = 'md',
  icon,
  iconRight,
  className = '',
  loading = false,
  ...rest
}) {
  return (
    <button
      type="button"
      className={`btn btn--${variant} btn--${size} ${className}`}
      {...rest}
    >
      {loading ? <Loader2 size={14} className="spin" /> : icon ? <span className="btn__icon">{icon}</span> : null}
      {children ? <span className="btn__label">{children}</span> : null}
      {iconRight ? <span className="btn__icon">{iconRight}</span> : null}
    </button>
  );
}

export function Pill({ children, tone = 'default', className = '', ...rest }) {
  return (
    <span className={`pill pill--${tone} ${className}`} {...rest}>
      {children}
    </span>
  );
}

export function Keys({ keys = [], size = 'md', onRemove, className = '' }) {
  return (
    <span className={`keys keys--${size} ${className}`}>
      {keys.map((k, i) => (
        <span key={`${k}-${i}`} className="key">
          {k}
        </span>
      ))}
      {onRemove ? (
        <button type="button" className="keys__remove" onClick={onRemove} aria-label="Удалить сочетание">
          ×
        </button>
      ) : null}
    </span>
  );
}

/** Выпадающий список в стиле настроек (значение справа, шеврон). */
export function Select({ value, onChange, options = [], placeholder = 'Выберите', width = 200, className = '' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div className={`select ${className}`} style={{ width }} ref={ref}>
      <button type="button" className="select__btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={current ? '' : 'select__placeholder'}>{current?.label ?? placeholder}</span>
        <ChevronDown size={13} className={open ? 'rot' : ''} />
      </button>
      {open ? (
        <div className="select__menu scroll-area" role="listbox">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`select__item ${o.value === value ? 'is-active' : ''}`}
              onClick={() => {
                onChange?.(o.value);
                setOpen(false);
              }}
            >
              <span className="select__item-main">{o.label}</span>
              {o.hint ? <span className="select__item-hint">{o.hint}</span> : null}
              {o.value === value ? <Check size={13} className="select__check" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Поиск', icon, className = '', ...rest }) {
  return (
    <label className={`search-input ${className}`}>
      {icon ? <span className="search-input__icon">{icon}</span> : null}
      <input
        type="text"
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(e) => onChange?.(e.target.value)}
        spellCheck={false}
        {...rest}
      />
    </label>
  );
}

export function Tabs({ items, value, onChange, variant = 'underline' }) {
  return (
    <div className={`tabs tabs--${variant}`} role="tablist">
      {items.map((item) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={`tabs__tab ${active ? 'is-active' : ''}`}
            onClick={() => onChange?.(item.id)}
          >
            <span>{item.label}</span>
            {item.count !== undefined ? (
              <span className={`tabs__count ${active ? 'is-active' : ''}`}>{item.count}</span>
            ) : null}
            {item.isNew ? <span className="badge-new badge-new--inline">НОВОЕ</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function EmptyState({ title, description, action, icon, compact = false }) {
  return (
    <div className={`empty ${compact ? 'empty--compact' : ''}`}>
      {icon ? <div className="empty__icon">{icon}</div> : null}
      <div className="empty__title">{title}</div>
      {description ? <div className="empty__desc">{description}</div> : null}
      {action ? <div className="empty__action">{action}</div> : null}
    </div>
  );
}

export function Spinner({ size = 16 }) {
  return <Loader2 size={size} className="spin" />;
}
