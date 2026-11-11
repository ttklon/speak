import { useEffect, useState } from 'react';
import { Check, Download, Loader, TriangleAlert } from 'lucide-react';
import { Button } from '../../ui/Controls.jsx';
import { useAppData } from '../../../state/AppDataProvider.jsx';
import { useToast } from '../../../state/ToastProvider.jsx';
import { MODELS } from '../../../lib/config.js';
import { engineName } from '../../../lib/recognition/engine.js';

/**
 * Модели распознавания: скачивание прямо из приложения (HTTPS с GitHub/HF),
 * прогресс в процентах, отметка «скачано». Кнопка «Скачать движок» ставит
 * whisper-cli.exe, если его ещё нет.
 */
export default function ModelManager() {
  const { settings, updateSettings } = useAppData();
  const { push } = useToast();
  const bridge = typeof window !== 'undefined' ? window.zspeakly?.native : null;

  const [status, setStatus] = useState(null); // { models: {...}, bin: bool }
  const [progress, setProgress] = useState({}); // id → percent
  const [busy, setBusy] = useState(null);

  const refresh = async ({ silent = true } = {}) => {
    if (!bridge?.modelsStatus) {
      if (!silent) {
        push({
          title: 'Модели — в установленном приложении',
          description: 'В браузере нет доступа к файлам модели: скачайте её в Windows-сборке ZSpeakly.',
          tone: 'warn',
        });
      }
      return null;
    }
    try {
      const next = await bridge.modelsStatus();
      // если main вернул не то, что ждём — не роняем плашку в «неизвестно»
      if (next && (next.models || next.bin !== undefined)) setStatus(next);
      if (!silent) {
        const found = next?.models ? Object.values(next.models).filter((m) => m.downloaded).length : 0;
        push({
          title: 'Статус обновлён',
          description: `${next?.bin ? 'движок на месте' : 'движка нет'} · моделей скачано: ${found}`,
          tone: next?.bin ? 'success' : 'warn',
        });
      }
      return next;
    } catch (err) {
      if (!silent) push({ title: 'Не удалось прочитать статус', description: String(err?.message || err), tone: 'warn' });
      return null;
    }
  };

  // Статус перечитываем сразу и по каждому событию загрузки, а не только
  // по «done»: иначе скачанная ранее модель оставалась «не скачанной»,
  // а кнопка «Обновить статус» ничего не перерисовывала.
  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (!bridge?.onModelProgress) return undefined;
    return bridge.onModelProgress((p) => {
      setProgress((prev) => ({ ...prev, [p.id]: p.percent }));
      // перечитываем статус на любом прогрессе: диск мог измениться извне
      refresh();
      if (p.done) {
        setBusy(null);
        if (p.ok) {
          push({
            title: p.id === 'engine' ? 'Движок установлен' : 'Модель скачана',
            description: p.id === 'engine' ? 'whisper.cpp готов к работе' : `${p.id} · перезапустите диктовку`,
            tone: 'success',
          });
        } else {
          push({ title: 'Не удалось скачать', description: p.reason, tone: 'warn' });
        }
      }
    });
  }, [bridge, push]);

  const download = async (id) => {
    if (!bridge?.downloadModel) {
      push({
        title: 'Скачивание доступно в приложении',
        description: 'В браузере моделями управляет установленная версия на Windows.',
        tone: 'warn',
      });
      return;
    }
    setBusy(id);
    setProgress((prev) => ({ ...prev, [id]: 0 }));
    updateSettings({ whisperModel: id });
    let res;
    try {
      res = await bridge.downloadModel(id);
    } catch (err) {
      res = { ok: false, reason: String(err?.message || err) };
    }
    // статус перечитываем в любом случае — даже если ответ потерялся
    await refresh();
    if (!res?.ok) {
      setBusy(null);
      push({ title: 'Не удалось скачать модель', description: res?.reason, tone: 'warn' });
    }
  };

  // Модель могли скачать вручную в «Загрузки» — даём подхватить её файлом
  const importModel = async () => {
    if (!bridge?.importModel) {
      push({ title: 'Только в установленном приложении', tone: 'warn' });
      return;
    }
    let res;
    try {
      res = await bridge.importModel();
    } catch (err) {
      res = { ok: false, reason: String(err?.message || err) };
    }
    if (res?.ok) {
      updateSettings({ whisperModel: res.id });
      push({
        title: 'Модель подключена',
        description: `ggml-${res.id}.bin · ${res.sizeMb} МБ`,
        tone: 'success',
      });
    } else if (res?.canceled) {
      push({ title: 'Файл не выбран', tone: 'warn' });
    } else {
      push({ title: 'Не удалось подключить модель', description: res?.reason, tone: 'warn' });
    }
    await refresh();
  };

  const downloadEngine = async () => {
    if (!bridge?.downloadEngine) {
      push({ title: 'Только в установленной версии', tone: 'warn' });
      return;
    }
    setBusy('engine');
    setProgress((prev) => ({ ...prev, engine: 0 }));
    let res;
    try {
      res = await bridge.downloadEngine();
    } catch (err) {
      res = { ok: false, reason: String(err?.message || err) };
    }
    await refresh();
    if (!res?.ok) {
      setBusy(null);
      push({ title: 'Движок не установился', description: res?.reason, tone: 'warn' });
    }
  };

  return (
    <div className="settings-group">
      <div className="settings-group__title">Модель распознавания</div>
      <div className="settings-group__desc">
        {/* на свежей установке движка и модели нет — говорим об этом прямо */}
        {status && (!status.bin || !Object.values(status.models || {}).some((m) => m.downloaded)) ? (
          <span className="model-setup-note">
            Для офлайн-диктовки нужны две вещи: движок whisper.cpp (≈20 МБ) и модель (от 75 МБ).
            Скачиваются сюда же, один раз — дальше всё работает без интернета.
          </span>
        ) : null}
        Движок сейчас: {engineName()}.
        {status ? (
          <>
            {' '}
            {status.bin ? (
              <span className="model-state model-state--ok">
                <Check size={11} /> whisper.cpp установлен
              </span>
            ) : (
              <span className="model-state model-state--warn">
                <TriangleAlert size={11} /> whisper.cpp не найден
              </span>
            )}
          </>
        ) : null}
      </div>

      {MODELS.map((m) => {
        const info = status?.models?.[m.id];
        const pct = progress[m.id];
        const active = settings.whisperModel === m.id;
        return (
          <div key={m.id} className={`model-card ${active ? 'is-active' : ''}`}>
            <button
              type="button"
              className="model-card__pick"
              onClick={() => updateSettings({ whisperModel: m.id })}
              title="Использовать эту модель"
            >
              <div className="grow" style={{ textAlign: 'left' }}>
                <div className="model-card__name">
                  {m.label}
                  {info?.downloaded ? <span className="model-badge">скачано · {info.actualMb} МБ</span> : null}
                </div>
                <div className="model-card__meta">
                  {m.size} · RAM {m.ram} · {m.speed} realtime · {m.quality}
                </div>
              </div>
              {active ? <Check size={13} style={{ color: 'var(--green)' }} /> : null}
            </button>

            {info?.downloaded ? null : (
              <Button
                variant="ghost"
                size="sm"
                icon={busy === m.id ? <Loader size={12} /> : <Download size={12} />}
                onClick={() => download(m.id)}
                disabled={Boolean(busy)}
              >
                {busy === m.id ? `${pct || 0}%` : 'Скачать'}
              </Button>
            )}
          </div>
        );
      })}

      <div className="row-8" style={{ marginTop: 8, flexWrap: 'wrap' }}>
        <Button
          variant="ghost"
          size="sm"
          icon={busy === 'engine' ? <Loader size={12} /> : <Download size={12} />}
          onClick={downloadEngine}
          disabled={Boolean(busy) || Boolean(status?.bin)}
        >
          {busy === 'engine' ? `Движок ${progress.engine || 0}%` : status?.bin ? 'Движок уже стоит' : 'Скачать движок whisper.cpp'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={importModel}
          disabled={Boolean(busy)}
        >
          Указать файл модели
        </Button>
        <Button
          variant="bare"
          size="sm"
          onClick={() => refresh({ silent: false })}
          logo={null}
        >
          Обновить статус
        </Button>
        {!bridge?.modelsStatus ? (
          <span className="settings-foot-hint">
            доступно в установленном приложении — в браузере нет доступа к диску
          </span>
        ) : null}
      </div>
      <div className="settings-foot-hint" style={{ marginTop: 8 }}>
        Модели качаются с официальных адресов (Hugging Face, GitHub) и лежат в %APPDATA%\ZSpeakly\models.
        В установщик они не входят — репозиторий остаётся лёгким.
      </div>
    </div>
  );
}
