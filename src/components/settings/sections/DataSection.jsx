import { useMemo, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Button, Select } from '../../ui/Controls.jsx';
import { Toggle } from '../../ui/Toggle.jsx';
import { plural } from '../../../lib/ai/style.js';
import { useAppData } from '../../../state/AppDataProvider.jsx';
import { useToast } from '../../../state/ToastProvider.jsx';
import { formatBytes } from '../../../lib/storage.js';
import ConfirmDialog from '../../ui/ConfirmDialog.jsx';

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
    exportBackup,
    importBackup,
  } = useAppData();
  const { push } = useToast();
  // «Удалить сейчас» стирало всю историю одним щелчком — теперь с подтверждением
  const [confirmDictations, setConfirmDictations] = useState(false);
  const [pendingBackup, setPendingBackup] = useState(null);
  const fileRef = useRef(null);

  const downloadBackup = () => {
    try {
      const data = exportBackup();
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      // локальная дата: toISOString отдаёт UTC и ночью показывает «завтра»
      const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `zspeakly-backup-${stamp}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      push({
        title: 'Копия скачана',
        description: `zspeakly-backup-${stamp}.json — ${dictations.length} записей истории и настройки. Буфер обмена не выгружается.`,
        tone: 'success',
      });
    } catch (err) {
      push({ title: 'Не удалось собрать копию', description: String(err?.message || err), tone: 'warn' });
    }
  };

  const readBackupFile = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      if (payload?.app && payload.app !== 'ZSpeakly') throw new Error('это копия другого приложения');
      setPendingBackup({ payload, name: file.name });
    } catch (err) {
      push({ title: 'Файл не подошёл', description: String(err?.message || err), tone: 'warn' });
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // Реальный размер именно диктовок. Раньше здесь было storageSize * 0.42 —
  // придуманное число, которое ничего не измеряло.
  // Blob.size уже возвращает байты UTF-8: умножать на 2 (как для UTF-16
  // в localStorage) здесь не нужно — было двойное счисление.
  const dictationBytes = useMemo(
    () => new Blob([JSON.stringify(dictations)]).size,
    [dictations],
  );

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
          <span className="setting-row__value">{formatBytes(dictationBytes)}</span>
          <Button
            variant="bare"
            size="sm"
            onClick={() => {
              if (!dictations.length) {
                push({ title: 'История уже пуста', tone: 'success' });
                return;
              }
              setConfirmDictations(true);
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
              const res = await bridge.openDataFolder();
              push({
                title: res?.ok ? 'Открыл папку данных' : 'Не удалось открыть папку',
                description: res?.path || res?.reason || '%APPDATA%\\ZSpeakly',
                tone: res?.ok ? 'success' : 'warn',
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
            Отправка ошибок
            <div className="setting-row__desc">
              Чтобы падения и сбои распознавания можно было починить. Уходят только технические
              события — без текста диктовки, буфера обмена и имени. По умолчанию журнал пишется
              только на этом компьютере: наружу ничего не уходит, пока не указан адрес приёмника.
              Прежний тумблер «Телеметрия» на это не влияет: сбора статистики в приложении нет.
            </div>
          </div>
          <Toggle
            checked={settings.diagnostics !== false}
            onChange={(v) => {
              updateSettings({ diagnostics: v });
              window.zspeakly?.native?.diagSetEnabled?.(v).catch?.(() => {});
            }}
          />
        </div>
        <div className="setting-row">
          <div className="setting-row__label">
            Диагностика и журнал
            <div className="setting-row__desc">
              Последние события, ручная отправка и папка с логами — в разделе «Диагностика».
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => onOpenSection('diagnostics')}>
            Открыть
          </Button>
        </div>
        <div className="setting-row">
          <div className="setting-row__label">Уведомления</div>
          <Toggle
            checked={settings.notifications}
            onChange={(v) => updateSettings({ notifications: v })}
          />
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group__title">Резервная копия</div>
        <div className="setting-row">
          <div className="setting-row__label">
            Скачать копию
            <div className="setting-row__desc">
              Словарь, свои инструкции, AI-инструкции, сочетания, настройки, профиль и история
              диктовок — одним JSON-файлом. Буфер обмена не выгружается: там бывают пароли и коды.
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={downloadBackup}>
            Скачать
          </Button>
        </div>
        <div className="setting-row">
          <div className="setting-row__label">
            Восстановить из файла
            <div className="setting-row__desc">
              Заменит текущие данные тем, что лежит в файле. Перед восстановлением спросим
              подтверждение и покажем, что внутри.
            </div>
          </div>
          <Button variant="bare" size="sm" onClick={() => fileRef.current?.click()}>
            Выбрать файл
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => readBackupFile(e.target.files?.[0])}
          />
        </div>
      </div>

      <div className="row-8" style={{ marginTop: 10 }}>
        <Button variant="bare" size="sm" onClick={() => onOpenSection?.('about')}>
          Что хранится на диске
        </Button>
      </div>

      <ConfirmDialog
        open={Boolean(pendingBackup)}
        onClose={() => setPendingBackup(null)}
        onConfirm={() => {
          const current = pendingBackup;
          setPendingBackup(null);
          if (!current) return;
          try {
            const applied = importBackup(current.payload);
            push({
              title: 'Копия восстановлена',
              description: `${current.name}: ${applied.join(', ')}.`,
              tone: 'success',
            });
          } catch (err) {
            push({ title: 'Не удалось восстановить', description: String(err?.message || err), tone: 'warn' });
          }
        }}
        title="Восстановить данные из копии?"
        description={
          pendingBackup
            ? `${pendingBackup.name} · от ${String(pendingBackup.payload?.exportedAt || 'неизвестной даты').slice(0, 10)}. Текущие история, словарь и настройки будут заменены.`
            : ''
        }
        confirmLabel="Восстановить"
      />

      <ConfirmDialog
        open={confirmDictations}
        onClose={() => setConfirmDictations(false)}
        onConfirm={() => {
          clearDictations();
          push({ title: 'История диктовок очищена', description: 'Отменить это нельзя.', tone: 'success' });
        }}
        title="Удалить всю историю диктовок?"
        description={`Будут удалены все расшифровки (${dictations.length} шт.). Настройки, словарь и буфер останутся.`}
        confirmLabel="Удалить"
      />
    </div>
  );
}
