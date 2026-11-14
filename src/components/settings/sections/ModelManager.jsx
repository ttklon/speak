import { useEffect, useRef, useState } from 'react';
import { Check, Download, Loader, TriangleAlert, X } from 'lucide-react';
import { Button } from '../../ui/Controls.jsx';
import { Toggle } from '../../ui/Toggle.jsx';
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
  // Одинаковые сообщения приходят и с события прогресса, и с ответа на
  // downloadModel — показываем одно, чтобы не было двух тостов подряд.
  const lastToast = useRef({ key: '', at: 0 });
  const pushOnce = (title, description, tone) => {
    const key = `${title}|${description || ''}`;
    const now = Date.now();
    if (lastToast.current.key === key && now - lastToast.current.at < 2500) return;
    lastToast.current = { key, at: now };
    push({ title, description, tone });
  };
  const cancelAsked = useRef(false);

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
        if (cancelAsked.current && !p.ok) {
          cancelAsked.current = false;
          pushOnce('Скачивание отменено', 'Недокачанный файл удалён — можно попробовать снова.', 'success');
          return;
        }
        if (p.ok) {
          push({
            title: p.id === 'engine' ? 'Движок установлен' : 'Модель скачана',
            description: p.id === 'engine' ? 'whisper.cpp готов к работе' : `${p.id} · перезапустите диктовку`,
            tone: 'success',
          });
        } else {
          pushOnce('Не удалось скачать', p.reason, 'warn');
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
      if (cancelAsked.current) {
        cancelAsked.current = false;
        pushOnce('Скачивание отменено', 'Недокачанный файл удалён — можно попробовать снова.', 'success');
      } else {
        pushOnce('Не удалось скачать модель', res?.reason, 'warn');
      }
    }
  };

  // Отмена посреди загрузки: модель весит сотни мегабайт, и без этой кнопки
  // остановить её можно было только закрыв приложение.
  const cancelDownload = async () => {
    if (!bridge?.modelsCancel) {
      push({ title: 'Отмена — в установленном приложении', tone: 'warn' });
      return;
    }
    cancelAsked.current = true;
    try {
      const res = await bridge.modelsCancel();
      if (!res?.ok) {
        cancelAsked.current = false;
        pushOnce('Отменять пока нечего', res?.reason || '', 'warn');
        setBusy(null);
      }
    } catch (err) {
      cancelAsked.current = false;
      pushOnce('Не удалось отменить', String(err?.message || err), 'warn');
    }
    await refresh();
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
        {status?.active ? (
          <>
            {' '}
            {status.active === status.preferred ? null : (
              <span className="model-state model-state--warn">
                <TriangleAlert size={11} /> выбранная «{status.preferred}» не скачана — работает «{status.active}»
              </span>
            )}
          </>
        ) : null}
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
              onClick={() => {
                // выбор модели раньше менял только галочку: без скачанного
                // файла диктовка молча не работала, и было непонятно почему
                updateSettings({ whisperModel: m.id });
                push(
                  info?.downloaded
                    ? { title: 'Модель выбрана', description: `${m.label} · ${m.size}`, tone: 'success' }
                    : {
                        title: 'Модель выбрана, но не скачана',
                        description: `${m.label} — нажмите «Скачать», иначе диктовка не заработает.`,
                        tone: 'warn',
                      },
                );
              }}
              title="Использовать эту модель"
            >
              <div className="grow" style={{ textAlign: 'left' }}>
                <div className="model-card__name">
                  {m.label}
                  {m.recommended ? <span className="model-badge model-badge--pick">рекомендуем для диктовки</span> : null}
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

      <div className="setting-row">
        <div className="setting-row__label">
          Держать модель в памяти
          <div className="setting-row__desc">
            Диктовка начинается без холодного старта: whisper-server загружает модель один раз и
            отвечает сразу. Занимает столько же памяти, сколько модель (≈2 ГБ для turbo), и
            работает только если в комплекте есть whisper-server.
          </div>
        </div>
        <Toggle
          checked={settings.keepModelLoaded === true}
          onChange={async (v) => {
            updateSettings({ keepModelLoaded: v });
            if (!v) {
              push({ title: 'Модель выгрузится из памяти', description: 'Следующая диктовка снова загрузит её при старте.', tone: 'success' });
              return;
            }
            if (!bridge?.modelsWarm) {
              push({ title: 'Только в приложении', description: 'В браузере модель не загружается в память.', tone: 'warn' });
              return;
            }
            const res = await bridge.modelsWarm({ model: settings.whisperModel, force: true }).catch(() => null);
            if (res?.ok) {
              push({ title: 'Модель в памяти', description: 'Диктовка начнётся без холодного старта.', tone: 'success' });
            } else {
              push({
                title: 'Модель не загружена в память',
                description: `${res?.reason || 'whisper-server недоступен'} — диктовка работает обычным путём.`,
                tone: 'warn',
              });
            }
          }}
        />
      </div>

      <div className="row-8" style={{ marginTop: 8, flexWrap: 'wrap' }}>
        {busy ? (
          <Button variant="white" size="sm" icon={<X size={12} />} onClick={cancelDownload}>
            Отменить скачивание
          </Button>
        ) : null}
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
