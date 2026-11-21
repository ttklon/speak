import Modal from './Modal.jsx';
import { Button } from './Controls.jsx';

/**
 * Подтверждение опасного действия.
 *
 * Раньше «Очистить историю» и «Сбросить все данные» срабатывали сразу по
 * одному щелчку: промах мышью стирал историю и словарь без пути назад.
 * Кнопка подтверждения красная, фокус по умолчанию — на «Отмене».
 */
export default function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title = 'Подтвердите действие',
  description = '',
  confirmLabel = 'Удалить',
  cancelLabel = 'Отмена',
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={420}
      footer={
        <>
          {/* data-autofocus: фокус сразу на «Отмене» — случайный Enter не удалит */}
          <Button variant="bare" onClick={onClose} data-autofocus>
            {cancelLabel}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              onConfirm?.();
              onClose?.();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="confirm__text">{description}</p>
    </Modal>
  );
}
