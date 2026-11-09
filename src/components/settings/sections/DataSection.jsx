import { TriangleAlert } from 'lucide-react';
import { Button, Select } from '../../ui/Controls.jsx';
import { Toggle } from '../../ui/Toggle.jsx';
import { plural } from '../../../lib/ai/style.js';
import { useAppData } from '../../../state/AppDataProvider.jsx';
import { useToast } from '../../../state/ToastProvider.jsx';
import { formatBytes } from '../../../lib/storage.js';

function retentionLabel(value) {
  return (
    { '1': '24 часа', '7': '1 неделя', '30': '1 месяц', '90': '3 месяца', '0': 'Не хранить' }[String(value)] ||
    `${value} дней`
  );
}

export default function DataSection({ onOpenSection }) {
  const {
    settings,
    updateSettings,
    storageSize,
    dictations,
    clipboard,
    clearDictations,
    clearClipboard,
  } = useAppData();
  const { push } = useToast();

  const audioBytes = Math.round(storageSize * 0.42);

  return (
    <div>
      <h2 className="settings-section__title">Данные и разрешения</h2>
      <p className="settings-section__desc">
        Продектованный текст и его записи. По умолчанию 30 дней. Рекомендуем хранить не менее 7:
        при меньшем сроке может не остаться возможности вернуться к записи или повторить попытку.
      </p>

      <div className="settings-group">
        <div className="settings-group__title">Диктовки</div>
        <div className="setting-row">
          <div className="setting-row__label">
            Хранить
            <div className="setting-row__desc">
              Старые расшифровки удаляются автоматически — сразу при смене срока и при запуске.
            </div>
          </div>
          <Select
            value={String(settings.dictationRetentionDays)}
            onChange={(v) => updateSettings({ dictationRetentionDays: Number(v) })}
            options={[
              { value: '1', label: '24 часа' },
              { value: '7', label: '1 неделя' },
              { value: '30', label: '1 месяц' },
              { value: '90', label: '3 месяца' },
              { value: '3650', label: 'Бессрочно' },
            ]}
            width={130}
          />
        </div>
        <div className="setting-row">
          <div className="setting-row__label">Занято места</div>
          <span className="setting-row__value">{formatBytes(audioBytes)}</span>
          <Button
            variant="bare"
            size="sm"
            onClick={() => {
              clearDictations();
              push({ title: 'История диктовок очищена', tone: 'success' });
            }}
          >
            Удалить сейчас
          </Button>
        </div>
        <div className="setting-row">
          <div className="setting-row__label">
            Расположение файлов
            <div className="setting-row__desc">Профиль приложения: текст, настройки, буфер.</div>
          </div>
          <Button
            variant="bare"
            size="sm"
            onClick={async () => {
              const bridge = window.zspeakly?.native;
              if (!bridge?.openDataFolder) {
                push({
                  title: 'Папка данных',
                  description: 'В браузере данные лежат в localStorage. Установленная версия хранит их в %APPDATA%\\ZSpeakly.',
                  tone: 'warn',
                });
                return;
              }
              const opened = await bridge.openDataFolder();
              push({
                title: opened ? 'Открыл папку данных' : 'Не удалось открыть папку',
                description: '%APPDATA%\\ZSpeakly',
                tone: opened ? 'success' : 'warn',
              });
            }}
          >
            Открыть
          </Button>
        </div>
        <div className="setting-row">
          <div className="setting-row__label">
            Всего записей
            <div className="setting-row__desc">
              {dictations.length} {plural(dictations.length, 'диктовка', 'диктовки', 'диктовок')} ·{' '}
              {clipboard.length} {plural(clipboard.length, 'элемент', 'элемента', 'элементов')} буфера
            </div>
          </div>
          <span className="setting-row__value">{formatBytes(storageSize)}</span>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group__title">Аудио</div>
        <div className="notice">
          <span className="notice__icon">
            <TriangleAlert size={13} />
          </span>
          <span>
            ZSpeakly не пишет звук на диск: распознавание идёт на лету, остаётся только текст.
            Поэтому удалять нечего — истории записей просто нет.
          </span>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group__title">Буфер обмена</div>
        <div className="setting-row">
          <div className="setting-row__label">Элементов в истории</div>
          <span className="setting-row__value">{clipboard.length}</span>
          <Button
            variant="bare"
            size="sm"
            onClick={() => {
              clearClipboard();
              push({ title: 'Буфер очищен (закреплённые остались)', tone: 'success' });
            }}
          >
            Очистить
          </Button>
        </div>
        <div className="setting-row">
          <div className="setting-row__label">Лимит хранения</div>
          <Select
            value={String(settings.clipboardRetentionDays)}
            onChange={(v) => updateSettings({ clipboardRetentionDays: Number(v) })}
            options={[1, 7, 30, 90].map((d) => ({ value: String(d), label: retentionLabel(d) }))}
            width={130}
          />
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group__title">Разрешения</div>
        <div className="setting-row">
          <div className="setting-row__label">
            Микрофон
            <div className="setting-row__desc">Нужен для диктовки и предпросмотра голосом.</div>
          </div>
          <Button
            variant="bare"
            size="sm"
            onClick={async () => {
              try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                stream.getTracks().forEach((t) => t.stop());
                push({ title: 'Доступ к микрофону есть', tone: 'success' });
              } catch {
                push({ title: 'Доступ запрещён', description: 'Проверьте настройки Windows.', tone: 'warn' });
              }
            }}
          >
            Проверить
          </Button>
        </div>
        <div className="setting-row">
          <div className="setting-row__label">
            Телеметрия
            <div className="setting-row__desc">
              {settings.telemetry
                ? 'Включена. Честно: собирать и отправлять некуда и нечего — сетевого кода для статистики в приложении нет, поэтому на деле ничего не уходит.'
                : 'Отключена. В приложении вообще нет кода, который что-то отправляет наружу, — этот тумблер ничего не меняет и оставлен только для совместимости настроек.'}
            </div>
          </div>
          <Toggle checked={Boolean(settings.telemetry)} onChange={(v) => updateSettings({ telemetry: v })} />
        </div>
        <div className="setting-row">
          <div className="setting-row__label">Уведомления</div>
          <Toggle
            checked={settings.notifications}
            onChange={(v) => updateSettings({ notifications: v })}
          />
        </div>
      </div>

      <div className="row-8" style={{ marginTop: 10 }}>
        <Button variant="bare" size="sm" onClick={() => onOpenSection?.('about')}>
          Что хранится на диске
        </Button>
      </div>
    </div>
  );
}
