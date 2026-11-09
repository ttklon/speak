import { useEffect, useState } from 'react';
import { Button, Select } from '../../ui/Controls.jsx';
import { Toggle } from '../../ui/Toggle.jsx';
import { useAppData } from '../../../state/AppDataProvider.jsx';
import { useToast } from '../../../state/ToastProvider.jsx';
import { engineName } from '../../../lib/recognition/engine.js';

export default function NetworkSection() {
  const { settings, updateSettings } = useAppData();
  const { push } = useToast();
  const [status, setStatus] = useState('idle');
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
      push({
        title: 'Локальная модель доступна',
        description: `${data.models?.length || 0} моделей в Ollama`,
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
      <h2 className="settings-section__title">Сеть</h2>
      <p className="settings-section__desc">
        ZSpeakly работает офлайн. Сеть нужна только для необязательной локальной модели и проверки
        обновлений на GitHub.
      </p>

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
          <span className="kv-row__key">Локальный сервер ИИ</span>
          <span className="kv-row__value">
            {status === 'ok' ? 'доступен' : status === 'fail' ? 'недоступен' : 'не проверялся'}
          </span>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group__title">Локальная модель</div>
        <div className="setting-row">
          <div className="setting-row__label">Адрес сервера</div>
          <input
            className="input settings-inline-input"
            value={settings.aiEndpoint}
            onChange={(e) => updateSettings({ aiEndpoint: e.target.value })}
          />
        </div>
        <div className="setting-row">
          <div className="setting-row__label">Модель</div>
          <input
            className="input settings-inline-input"
            value={settings.aiModel}
            onChange={(e) => updateSettings({ aiModel: e.target.value })}
          />
        </div>
        <div className="row-8">
          <Button variant="ghost" size="sm" onClick={check} loading={status === 'checking'}>
            Проверить соединение
          </Button>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group__title">Обновления</div>
        <div className="setting-row">
          <div className="setting-row__label">
            Проверять обновления на GitHub
            <div className="setting-row__desc">Раз в сутки при наличии сети, без отправки телеметрии.</div>
          </div>
          <Toggle
            checked={settings.checkUpdates !== false}
            onChange={(v) => updateSettings({ checkUpdates: v })}
          />
        </div>
        <div className="setting-row">
          <div className="setting-row__label">Канал</div>
          <Select
            value={settings.updateChannel || 'stable'}
            onChange={(v) => {
              updateSettings({ updateChannel: v });
              // сообщаем апдейтеру: бета-канал включается сразу
              window.zspeakly?.native?.setUpdateChannel?.(v);
              push({
                title: v === 'beta' ? 'Бета-канал включён' : 'Стабильный канал',
                description:
                  v === 'beta'
                    ? 'Приложение будет видеть и предрелизные версии.'
                    : 'Только проверенные релизы.',
                tone: 'success',
              });
            }}
            options={[
              { value: 'stable', label: 'Стабильный' },
              { value: 'beta', label: 'Бета' },
            ]}
            width={160}
          />
        </div>
      </div>
    </div>
  );
}
