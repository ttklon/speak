import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../ui/Controls.jsx';
import { Toggle } from '../../ui/Toggle.jsx';
import { useAppData } from '../../../state/AppDataProvider.jsx';
import { useToast } from '../../../state/ToastProvider.jsx';
import { formatBytes } from '../../../lib/storage.js';
import { BACKUP_MAX_BYTES, prepareBackup, readBackupJsonFile } from '../../../lib/backup.js';
import ConfirmDialog from '../../ui/ConfirmDialog.jsx';


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
  // Срок хранения задаёт приложение (lib/autotune.js), но показываем честно его
  const retentionDays = Number(settings.dictationRetentionDays) || 30;
  // «Удалить сейчас» стирало всю историю одним щелчком — теперь с подтверждением
  const [confirmDictations, setConfirmDictations] = useState(false);
  const [pendingBackup, setPendingBackup] = useState(null);
  const fileRef = useRef(null);
  const backupReadRef = useRef(0);
  useEffect(() => () => { backupReadRef.current += 1; }, []);

  const downloadBackup = async () => {
    let data;
    try {
      data = exportBackup();
    } catch (err) {
      push({ title: 'Не удалось собрать копию', description: String(err?.message || err), tone: 'warn' });
      return;
    }
    let json;
    let blob;
    try {
      json = JSON.stringify(data, null, 2);
      blob = new Blob([json], { type: 'application/json' });
    } catch (err) {
      push({ title: 'Не удалось собрать копию', description: String(err?.message || err), tone: 'warn' });
      return;
    }
    const oversized = blob.size > BACKUP_MAX_BYTES;
    const sizeWarning = oversized ? ' Размер превышает 32 МиБ: приложение не сможет восстановить её целиком автоматически.' : '';
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    // локальная дата: toISOString отдаёт UTC и ночью показывает «завтра»
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const bridge = window.zspeakly?.native;
    // В установленной версии файл кладёт главный процесс — рядом с отчётом
    // диагностики, и сразу показывает его в проводнике.
    if (bridge?.saveBackup) {
      try {
        const res = await bridge.saveBackup(json);
        push(
          res?.ok
            ? {
                title: 'Копия сохранена',
                description: `${res.path || `zspeakly-backup-${stamp}.json`} — история (${dictations.length}) и настройки.${sizeWarning}`,
                tone: oversized ? 'warn' : 'success',
                ttl: oversized ? 12000 : undefined,
              }
            : { title: 'Не удалось сохранить копию', description: res?.reason, tone: 'warn' },
        );
        return;
      } catch (err) {
        push({ title: 'Не удалось сохранить копию', description: String(err?.message || err), tone: 'warn' });
        return;
      }
    }
    // Браузер: обычная загрузка файла
    try {
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
        description: `zspeakly-backup-${stamp}.json — ${dictations.length} записей истории и настройки. Буфер обмена не выгружается.${sizeWarning}`,
        tone: oversized ? 'warn' : 'success',
        ttl: oversized ? 12000 : undefined,
      });
    } catch (err) {
      push({ title: 'Не удалось скачать копию', description: String(err?.message || err), tone: 'warn' });
    }
  };

  const readBackupFile = async (file) => {
    if (!file) return;
    const readId = ++backupReadRef.current;
    setPendingBackup(null);
    try {
      const payload = await readBackupJsonFile(file);
      // Если пока читали выбрали другой файл, первый больше не должен менять
      // предпросмотр или показывать ошибку поверх последнего выбора.
      if (readId !== backupReadRef.current) return;
      if (payload?.app && payload.app !== 'ZSpeakly') {
        throw new Error(`это копия другого приложения (${String(payload.app).slice(0, 40)})`);
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('в файле нет данных ZSpeakly');
      }
      const prepared = prepareBackup(payload);
      const labels = {
        settings: 'настройки', dictations: 'история', dictionary: 'словарь', snippets: 'быстрые блоки',
        voiceHotkeys: 'голосовые сочетания', presets: 'AI-инструкции', instructions: 'свои инструкции',
        stats: 'счётчики', profile: 'профиль',
      };
      const sections = Object.keys(labels).filter((key) => Object.prototype.hasOwnProperty.call(prepared, key)).map((key) => labels[key]);
      setPendingBackup({ payload, name: file.name, sections });
    } catch (err) {
      if (readId === backupReadRef.current) push({ title: 'Файл не подошёл', description: String(err?.message || err), tone: 'warn' });
    } finally {
      if (readId === backupReadRef.current && fileRef.current) fileRef.current.value = '';
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
      <div className="settings-group">
        <div className="settings-group__title">Диктовки</div>
        <div className="setting-row">
          <div className="setting-row__label">
            Занято места
            {/* Срок хранения и число записей раньше были отдельными строками:
                три строки про одно и то же. Теперь одна строка с ответами. */}
            <div className="setting-row__desc">
              {dictations.length + clipboard.length} записей · храним {retentionDays} дней · диктовки{' '}
              {formatBytes(dictationBytes)}
            </div>
          </div>
          <span className="setting-row__value">{formatBytes(storageSize)}</span>
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
        <div className="settings-foot-hint" style={{ marginTop: 6 }}>
          Звук никуда не пишется: распознавание идёт на лету, остаётся только текст.
        </div>
      </div>


      <div className="settings-group">
        <div className="settings-group__title">Буфер обмена</div>
        <div className="setting-row">
          <div className="setting-row__label">
            Запоминать скопированное
            <div className="setting-row__desc">
              Текст, картинки и пароли — только на этом компьютере.
            </div>
          </div>
          <Toggle
            checked={settings.clipboardMonitor !== false}
            onChange={(v) => updateSettings({ clipboardMonitor: v })}
          />
        </div>
        <div className="setting-row">
          <div className="setting-row__label">
            Элементов в истории
            <div className="setting-row__desc">
              Сколько помнить — приложение решает само: последние 5000 записей или месяц.
            </div>
          </div>
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
        {/* Тумблер отправки живёт в «Диагностике» — там же адрес приёмника, состояние
            журнала и кнопка «Сохранить отчёт в файл». Два одинаковых тумблера в двух
            разделах читались как две разные настройки. */}
        <div className="setting-row">
          <div className="setting-row__label">
            Отправка отчётов
            <div className="setting-row__desc">
              Журнал пишется на этом компьютере: без текста диктовки, буфера обмена и имени.
              Включается и настраивается в «Диагностике» — рядом видно, что именно уходит.
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => onOpenSection('diagnostics')}>
            Открыть
          </Button>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group__title">Резервная копия</div>
        <div className="setting-row">
          <div className="setting-row__label">
            Скачать копию
            <div className="setting-row__desc">
              Словарь, свои инструкции, AI-инструкции, сочетания, настройки, профиль и история
              диктовок — одним JSON-файлом без шифрования. Буфер обмена не выгружается.
              Секреты могут встретиться в диктовках, инструкциях и адресах настроек — храните копию в безопасном месте.
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
              Заменит выбранные разделы данными из файла. Перед восстановлением спросим
              подтверждение и покажем, что внутри. Автоматический импорт ограничен 32 МиБ.
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()}>
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
        <Button variant="bare" size="sm" onClick={() => onOpenSection?.('app')}>
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
            let status;
            try { status = window.zspeakly?.store?.statusSync?.(); } catch { status = { ok: false }; }
            push({
              title: 'Данные применены в приложении',
              description: status?.ok === false
                ? `${current.name}: ${applied.join(', ')}. Профиль защищён от записи или не сохранён: изменения могут быть потеряны.`
                : `${current.name}: ${applied.join(', ')}. Запись в профиль выполняется отдельно; следите за предупреждениями о сохранении.`,
              tone: status?.ok === false ? 'warn' : 'info',
              ttl: 10000,
            });
          } catch (err) {
            push({ title: 'Не удалось восстановить', description: String(err?.message || err), tone: 'warn' });
          }
        }}
        title="Восстановить данные из копии?"
        description={
          pendingBackup
            ? `${pendingBackup.name} · от ${String(pendingBackup.payload?.exportedAt || 'неизвестной даты').slice(0, 10)}. Будут заменены: ${pendingBackup.sections.join(', ')}. Старые записи могут удалиться по сроку хранения при следующем запуске.`
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
