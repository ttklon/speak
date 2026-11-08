import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import Modal from '../ui/Modal.jsx';
import { APP } from '../../lib/config.js';

/** Модалка «ZSpeakly на вашем телефоне» — QR + App Store / Google Play (кадр 148s). */
export default function MobileModal({ open, onClose }) {
  const [qr, setQr] = useState(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    QRCode.toDataURL(APP.repo, {
      margin: 0,
      width: 360,
      errorCorrectionLevel: 'M',
      color: { dark: '#0a0a0bff', light: '#ffffffff' },
    })
      .then((url) => {
        if (!cancelled) setQr(url);
      })
      .catch(() => setQr(null));
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title="ZSpeakly на вашем телефоне" width={340} hideClose={false}>
      <div className="qr-wrap">
        <div className="qr-box">
          {qr ? <img src={qr} alt="QR-код ZSpeakly" /> : <div className="qr-skeleton" />}
          <span className="qr-logo">Z</span>
        </div>
        <p className="qr-hint">
          Отсканируйте этот QR-код камерой телефона или приложением для сканирования
        </p>
        <div className="store-badges">
          <span className="store-badge">
            <svg width="14" height="16" viewBox="0 0 14 16" fill="currentColor" aria-hidden>
              <path d="M11.2 8.5c0-1.6 1.3-2.4 1.4-2.4-.8-1.1-2-1.3-2.4-1.3-1-.1-2 .6-2.5.6-.5 0-1.3-.6-2.2-.6-1.1 0-2.2.7-2.8 1.7-1.2 2-.3 5.1.9 6.8.6.8 1.2 1.7 2.1 1.7.8 0 1.1-.5 2.1-.5s1.3.5 2.1.5c.9 0 1.5-.8 2-1.6.6-.9.9-1.8.9-1.9 0 0-1.7-.7-1.6-2.6zM9.6 3.3c.4-.6.8-1.3.7-2.1-.7 0-1.5.5-2 1-.4.5-.8 1.3-.7 2 .8.1 1.5-.4 2-1z" />
            </svg>
            <span>
              <span className="store-badge__top">Download on the</span>
              <span className="store-badge__bottom">App Store</span>
            </span>
          </span>
          <span className="store-badge">
            <svg width="14" height="15" viewBox="0 0 14 15" fill="none" aria-hidden>
              <path d="M1 1.3v12.4c0 .4.4.7.8.5l7.4-6.2c.3-.2.3-.6 0-.8L1.8.8c-.4-.2-.8.1-.8.5z" fill="#5a9cf8" />
              <path d="M9.9 5.4l1.9 1.6c.3.2.3.6 0 .8l-1.9 1.6-2.2-2 2.2-2z" fill="#f6d365" />
              <path d="M1.4 1l6.3 5.4-6.5 5.5c-.1-.1-.2-.3-.2-.5V1.5c0-.2.1-.4.4-.5z" fill="#5fd08a" />
              <path d="M7.7 7.4L1.4 13.9c.3.2.7.2 1 0l7.5-4.5-2.2-2z" fill="#e5534b" />
            </svg>
            <span>
              <span className="store-badge__top">GET IT ON</span>
              <span className="store-badge__bottom">Google Play</span>
            </span>
          </span>
        </div>
        <p className="qr-foot">
          Мобильная версия в разработке. Сейчас QR ведёт на репозиторий проекта — там инструкции и
          релизы десктопной сборки.
        </p>
      </div>
    </Modal>
  );
}
