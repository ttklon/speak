/** Тоггл 36×20 в стиле оригинала: зелёный #15C660, белый кружок. */

export default function Toggle({ checked, onChange, label, disabled = false, size = 'md' }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={Boolean(checked)}
      aria-label={label}
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
