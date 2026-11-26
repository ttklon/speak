import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../ui/Controls.jsx';
import { Toggle } from '../../ui/Toggle.jsx';
import { useAppData } from '../../../state/AppDataProvider.jsx';
import { useToast } from '../../../state/ToastProvider.jsx';
import { formatBytes, isElectron } from '../../../lib/storage.js';
import { BACKUP_MAX_BYTES, describeBackupCompatibility, prepareBackup, readBackupJsonFile } from '../../../lib/backup.js';
import { BACKUP_SECTIONS, backupIdentitySummary, backupRetentionImpact, backupSectionSummary, selectBackupSections } from '../../../lib/backupPreview.js';
import ConfirmDialog from '../../ui/ConfirmDialog.jsx';


// Экспорт собирается из состояния renderer, а не из исходного файла профиля.
// Неизвестный статус нельзя считать признаком полной и исправной копии.
function isBackupPotentiallyIncomplete() {
  if (!isElectron()) return false;
  try { return window.zspeakly?.store?.statusSync?.()?.ok !== true; }
  catch { return true; }
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
  // Срок хранения задаёт приложение (lib/autotune.js), но показываем честно его
  const retentionDays = Number(settings.dictationRetentionDays) || 30;
  // «Удалить сейчас» стирало всю историю одним щелчком — теперь с подтверждением
  const [confirmDictations, setConfirmDictations] = useState(false);
  const [pendingBackup, setPendingBackup] = useState(null);
  const fileRef = useRef(null);
  const backupReadRef = useRef(0);
  useEffect(() => () => { backupReadRef.current += 1; }, []);

  const downloadBackup = async () => {
    const wasUncertain = isBackupPotentiallyIncomplete();
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
        const uncertain = wasUncertain || isBackupPotentiallyIncomplete();
        const incompleteWarning = uncertain
          ? ' Состояние профиля не подтверждено: копия из памяти может быть неполной. Сохраните исходные файлы профиля отдельно.'
          : '';
        push(
          res?.ok
            ? {
                title: 'Копия сохранена',
                description: `${res.path || `zspeakly-backup-${stamp}.json`} — история (${dictations.length}) и настройки.${sizeWarning}${incompleteWarning}`,
                tone: oversized || uncertain ? 'warn' : 'success',
                ttl: oversized || uncertain ? 12000 : undefined,
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
      const uncertain = wasUncertain || isBackupPotentiallyIncomplete();
      const incompleteWarning = uncertain
        ? ' Состояние профиля не подтверждено: копия из памяти может быть неполной. Сохраните исходные файлы профиля отдельно.'
        : '';
      push({
        title: 'Копия скачана',
        description: `zspeakly-backup-${stamp}.json — ${dictations.length} записей истории и настройки. Буфер обмена не выгружается.${sizeWarning}${incompleteWarning}`,
        tone: oversized || uncertain ? 'warn' : 'success',
        ttl: oversized || uncertain ? 12000 : undefined,
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
      const prepared = prepareBackup(payload);
      const compatibility = describeBackupCompatibility(payload);
      const sections = Object.keys(BACKUP_SECTIONS).filter((key) => Object.hasOwn(prepared, key));
      setPendingBackup({ payload, prepared, compatibility, name: file.name, sections, selected: sections });
    } catch (err) {
      if (readId === backupReadRef.current) push({ title: 'Файл не подошёл', description: String(err?.message || err), tone: 'warn' });
    } finally {
      if (readId === backupReadRef.current && fileRef.current) fileRef.current.value = '';
    }
  };

  // Считаем по текущим данным при каждом рендере, не показывая содержание буфера.
  // Пока диалог открыт, записи и время могут измениться: числа ориентировочные.
  const selectedPrepared = pendingBackup
    ? Object.fromEntries(pendingBackup.selected.map((key) => [key, pendingBackup.prepared[key]]))
    : null;
  const retentionImpact = pendingBackup && pendingBackup.selected.length
    ? backupRetentionImpact({ prepared: selectedPrepared, settings, dictations, clipboard })
    : null;
  const retentionWarning = retentionImpact && (selectedPrepared.settings || selectedPrepared.dictations || retentionImpact.dictations || retentionImpact.clipboard)
    ? ` Старые записи могут удалиться по сроку хранения сразу после восстановления или при следующем запуске.` +
      (retentionImpact.dictations ? ` Сейчас под срок хранения попадают записи ${retentionImpact.importedHistory ? 'истории из копии' : 'текущей истории'}: ${retentionImpact.dictations}.` : '') +
      (selectedPrepared.settings || retentionImpact.clipboard
        ? ` Буфер обмена не входит в копию; срок хранения может удалить его текущие незакреплённые записи${retentionImpact.clipboard ? ` (сейчас под срок попадает: ${retentionImpact.clipboard})` : ''}.`
        : '') +
      ((retentionImpact.dictations || retentionImpact.clipboard) ? ' Количество может измениться.' : '')
    : '';

  const currentBackup = pendingBackup ? exportBackup() : null;

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
              Фоновый опрос буфера. В истории появляются не все типы и события;
              секреты могут сохраниться открыто. При включении текущее содержимое
              тоже может попасть в историю.
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
              подтверждение, покажем состав и дадим выбрать разделы. Каждый выбранный
              раздел заменяется целиком, не объединяется. Автоматический импорт ограничен 32 МиБ.
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
            const selected = selectBackupSections(current.payload, current.selected);
            const applied = importBackup(selected);
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
            ? `${pendingBackup.name} · от ${String(pendingBackup.payload?.exportedAt || 'неизвестной даты').slice(0, 10)}. Будут заменены: ${pendingBackup.selected.map((key) => BACKUP_SECTIONS[key].toLowerCase()).join(', ') || 'ничего не выбрано'}.${pendingBackup.compatibility.legacy ? ' Копия без полной метки приложения или версии: совместимость не гарантирована.' : ''}${pendingBackup.compatibility.ignoredFields ? ` Нераспознанные поля верхнего уровня будут пропущены: ${pendingBackup.compatibility.ignoredFields}.` : ''}${retentionWarning} Восстановление не атомарно: при сбое часть прежних данных может быть заменена, а часть — нет. Сначала сохраните отдельную копию текущих данных; при повреждённом профиле она может быть неполной.`
            : ''
        }
        confirmLabel="Восстановить"
        confirmDisabled={!pendingBackup?.selected.length}
        width={540}
      >
        {pendingBackup ? (
          <fieldset className="backup-sections">
            <legend>Выберите разделы для замены</legend>
            <div className="backup-sections__actions">
              <button type="button" onClick={() => setPendingBackup((prev) => prev ? { ...prev, selected: prev.sections } : prev)}>Выбрать все</button>
              <button type="button" onClick={() => setPendingBackup((prev) => prev ? { ...prev, selected: [] } : prev)}>Снять все</button>
              <button type="button" onClick={downloadBackup}>Скачать текущую копию</button>
            </div>
            <p className="backup-sections__hint">Разделы заменяются целиком. Совпадение ID не означает совпадение текста или других данных.</p>
            {pendingBackup.sections.map((key) => {
              const identity = backupIdentitySummary(key, pendingBackup.prepared, currentBackup);
              return (
                <label className="backup-sections__item" key={key}>
                  <input type="checkbox" checked={pendingBackup.selected.includes(key)}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setPendingBackup((prev) => prev ? { ...prev, selected: checked
                        ? prev.sections.filter((section) => section === key || prev.selected.includes(section))
                        : prev.selected.filter((section) => section !== key) } : prev);
                    }} />
                  <span><strong>{BACKUP_SECTIONS[key]}</strong><small>{backupSectionSummary(key, pendingBackup.prepared, currentBackup)}</small>
                    {identity ? <small>{identity}</small> : null}</span>
                </label>
              );
            })}
          </fieldset>
        ) : null}
      </ConfirmDialog>

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
