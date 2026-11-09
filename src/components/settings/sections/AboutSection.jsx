import { useEffect, useState } from 'react';
import { Button } from '../../ui/Controls.jsx';
import { APP } from '../../../lib/config.js';
import { ENGINE_LABEL, IS_ELECTRON } from '../../../lib/constants.js';
import { plural } from '../../../lib/ai/style.js';
import { useAppData } from '../../../state/AppDataProvider.jsx';
import UpdateRow from './UpdateRow.jsx';
import { useToast } from '../../../state/ToastProvider.jsx';

export default function AboutSection() {
  const { dictations, dictionary, clipboard, settings } = useAppData();
  const { push } = useToast();
  const [stt, setStt] = useState(null);
  // Папка docs лежит внутри приложения — открываем её в системном проводнике,
  // а если её нет в сборке, ведём на страницу документации в репозитории.
  const openDocs = async () => {
    const res = await window.zspeakly?.native?.openDocs?.();
    if (res && res.ok === false) {
      push({ title: 'Документация', description: res.reason || 'Открываю страницу в браузере', tone: 'warn' });
      window.zspeakly?.native?.openExternal?.(`${APP.repo}/tree/main/docs`)?.catch?.(() => {});
    } else if (!window.zspeakly?.native?.openDocs) {
      window.open?.(`${APP.repo}/tree/main/docs`, '_blank', 'noopener');
    }
  };

  // На Windows спрашиваем main-процесс: нашлись ли whisper-cli.exe и модель
  useEffect(() => {
    const bridge = window.zspeakly?.native;
    if (!bridge?.sttStatus) return;
    let alive = true;
    bridge.sttStatus(settings.whisperModel).then((res) => {
      if (alive) setStt(res);
    });
    return () => {
      alive = false;
    };
  }, [settings.whisperModel]);

  return (
    <div>
      <h2 className="settings-section__title">О программе</h2>
      <p className="settings-section__desc">ZSpeakly — бесплатный офлайн-голосовой ввод, собранный по мотивам видео-обзора.</p>

      <div className="about-hero">
        <div className="about-logo">Z</div>
        <div>
          <div className="about-name">ZSpeakly</div>
          <div className="about-version">
            Версия {APP.version} · сборка {APP.build}
          </div>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group__title">Среда</div>
        <div className="kv-row">
          <span className="kv-row__key">Оболочка</span>
          <span className="kv-row__value">{IS_ELECTRON ? 'Electron (десктоп)' : 'Браузер (превью)'}</span>
        </div>
        <div className="kv-row">
          <span className="kv-row__key">Распознавание речи</span>
          <span className="kv-row__value">{ENGINE_LABEL}</span>
        </div>
        {IS_ELECTRON ? (
          <div className="kv-row">
            <span className="kv-row__key">whisper.cpp</span>
            <span className="kv-row__value">
              {stt === null
                ? 'проверяю…'
                : stt.available
                  ? `готов · ${String(stt.model || '').split(/[\\/]/).pop()}`
                  : `${stt.reason} — запустите scripts\download-models.ps1`}
            </span>
          </div>
        ) : null}
        <div className="kv-row">
          <span className="kv-row__key">Данные</span>
          <span className="kv-row__value">
            {dictations.length} {plural(dictations.length, 'диктовка', 'диктовки', 'диктовок')} ·{' '}
            {dictionary.length} {plural(dictionary.length, 'слово', 'слова', 'слов')} ·{' '}
            {clipboard.length} в буфере
          </span>
        </div>
        <div className="kv-row">
          <span className="kv-row__key">Хранение</span>
          <span className="kv-row__value">локальный профиль, без облака</span>
        </div>
        <div className="kv-row">
          <span className="kv-row__key">Лицензия</span>
          <span className="kv-row__value">MIT</span>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group__title">Документация</div>
        <p className="settings-group__desc">
          Покадровый разбор интерфейса, план разработки и инструкция по моделям лежат в папке{' '}
          <code>docs/</code> репозитория.
        </p>
        <div className="row-8" style={{ flexWrap: 'wrap' }}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              // в Electron window.open блокируется — идём через мост,
              // у него есть allowlist доменов; в браузере хватает window.open
              const bridge = window.zspeakly?.native?.openExternal;
              if (bridge) bridge(APP.repo).catch?.(() => {});
              else window.open?.(APP.repo, '_blank', 'noopener');
            }}
          >
            Открыть репозиторий
          </Button>
          <Button variant="ghost" size="sm" onClick={() => openDocs()}>
            Открыть документацию
          </Button>
        </div>
        <UpdateRow />
      </div>

      <div className="settings-group">
        <div className="settings-group__title">Горячие клавиши приложения</div>
        <div className="kv-row">
          <span className="kv-row__key">Диктовка</span>
          <span className="kv-row__value">{(settings.dictationKeys || ['Ctrl', 'Alt', 'Space']).join(' + ')}</span>
        </div>
        <div className="kv-row">
          <span className="kv-row__key">Настройки</span>
          <span className="kv-row__value">Ctrl + ,</span>
        </div>
        <div className="kv-row">
          <span className="kv-row__key">Поиск по буферу</span>
          <span className="kv-row__value">Ctrl + K</span>
        </div>
        <div className="kv-row">
          <span className="kv-row__key">Демо-диктовка (браузер)</span>
          <span className="kv-row__value">Alt + D</span>
        </div>
      </div>
    </div>
  );
}
