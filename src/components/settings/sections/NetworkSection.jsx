import { useEffect, useState } from 'react';
import { Button } from '../../ui/Controls.jsx';
import { useAppData } from '../../../state/AppDataProvider.jsx';
import { useToast } from '../../../state/ToastProvider.jsx';
import { engineName } from '../../../lib/recognition/engine.js';
import { llmIsDown, resetLlmBackoff } from '../../../lib/ai/textops.js';

export default function NetworkSection() {
  const { settings } = useAppData();
  const { push } = useToast();
  const [status, setStatus] = useState('idle');
  // какие модели реально отдаёт локальный сервер — чтобы не вписывать имя вслепую
  const [models, setModels] = useState([]);
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const check = async () => {
    setStatus('checking');
    // В окне Electron запрос к localhost идёт мимо политики страницы,
    // иначе адрес Ollama пришлось бы вписывать в CSP.
    const viaNative = window.zspeakly?.native?.httpGet;
    try {
      const url = `${String(settings.aiEndpoint || '').replace(/\/$/, '')}/api/tags`;
      const res = viaNative
        ? await viaNative(url)
        : await fetch(url, { method: 'GET' }).then(async (r) => ({
            ok: r.ok,
            status: r.status,
            data: await r.json().catch(() => null),
          }));
      if (!res?.ok) throw new Error(`bad status ${res?.status ?? '?'}`);
      if (!res.ok) throw new Error('bad status');
      const data = res.data || {};
      setStatus('ok');
      const names = Array.isArray(data.models) ? data.models.map((m) => m.name || m.model).filter(Boolean) : [];
      setModels(names);
      // модель ответила — снимаем «паузу недоступности», инструкции снова
      // попробуют её, а не сразу пойдут по офлайн-правилам
      resetLlmBackoff();
      push({
        title: 'Локальная модель доступна',
        description: `Ollama отвечает, моделей: ${names.length || 0}`,
        tone: 'success',
      });
    } catch {
      setStatus('fail');
      push({
        title: 'Локальная модель недоступна',
        description: `Проверьте адрес ${settings.aiEndpoint}. Диктовка работает и без него.`,
        tone: 'warn',
      });
    }
  };

  return (
    <div>
      <div className="settings-group">
        <div className="settings-group__title">Состояние</div>
        <div className="kv-row">
          <span className="kv-row__key">Интернет</span>
          <span className="kv-row__value">{online ? 'подключён' : 'нет соединения'}</span>
        </div>
        <div className="kv-row">
          <span className="kv-row__key">Движок распознавания</span>
          <span className="kv-row__value">{engineName()}</span>
        </div>
        <div className="kv-row">
          <span className="kv-row__key">Адрес сервера</span>
          <span className="kv-row__value">{settings.aiEndpoint}</span>
        </div>
        <div className="kv-row">
          <span className="kv-row__key">Локальный сервер ИИ</span>
          <span className="kv-row__value">
            {status === 'ok' ? 'доступен' : status === 'fail' ? 'недоступен' : 'не проверялся'}
            {llmIsDown() ? ' · пауза после сбоя: инструкции работают офлайн' : ''}
          </span>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group__title">Модель для инструкций</div>
        {/* Адрес и имя модели приложение ищет само на этом компьютере: раньше
            человек должен был знать, что такое Ollama и какой там порт. */}
        <div className="setting-row">
          <div className="setting-row__label">
            Найдена на этом компьютере
            <div className="setting-row__desc">
              {models.length
                ? `Используется ${settings.aiModel}. Другие модели выбираются сами, если эта перестанет отвечать.`
                : 'Если модели нет, инструкции по выделенному тексту работают офлайн-правилами.'}
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={check} loading={status === 'checking'}>
            Проверить соединение
          </Button>
        </div>
      </div>

    </div>
  );
}
