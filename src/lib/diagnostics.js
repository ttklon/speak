/**
 * Диагностика на стороне интерфейса.
 *
 * Всё, что может сломаться в рендерере (падение компонента, отказ промиса,
 * ошибка распознавания), уходит в main-процесс, оттуда — в локальный журнал
 * и, если пользователь не выключил тумблер, в приёмник. Текст диктовки и
 * буфер обмена не отправляются: main выбрасывает такие поля.
 *
 * В браузере (dev-preview) моста нет — пишем в консоль и в localStorage,
 * чтобы страница «Диагностика» всё равно что-то показывала.
 */

const LOCAL_KEY = 'zs.diagnostics.buffer';
const MAX_LOCAL = 200;

const bridge = () => (typeof window !== 'undefined' ? window.zspeakly?.native : null);

function localPush(entry) {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    const list = raw ? JSON.parse(raw) : [];
    list.push(entry);
    localStorage.setItem(LOCAL_KEY, JSON.stringify(list.slice(-MAX_LOCAL)));
  } catch {
    /* localStorage может быть недоступен */
  }
}

export function localEvents() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function emit(level, scope, message, data) {
  const entry = {
    at: Date.now(),
    level,
    scope: String(scope || 'ui'),
    message: String(message || '').slice(0, 1000),
    data: data || {},
  };
  const b = bridge();
  if (b?.log) {
    // main сам решает, писать ли на диск и отправлять ли наружу
    b.log(entry).catch?.(() => {});
  } else {
    localPush(entry);
    if (level === 'error') console.error(`[${scope}] ${message}`, data || '');
    else if (level === 'warn') console.warn(`[${scope}] ${message}`, data || '');
  }
  return entry;
}

export const diag = {
  debug: (scope, message, data) => emit('debug', scope, message, data),
  info: (scope, message, data) => emit('info', scope, message, data),
  warn: (scope, message, data) => emit('warn', scope, message, data),
  error: (scope, message, data) => emit('error', scope, message, data),
  localEvents,
};

/**
 * Ставит глобальные перехватчики один раз за жизнь окна.
 * Возвращает функцию снятия (нужна тестам).
 */
export function installErrorHooks() {
  if (typeof window === 'undefined') return () => {};
  if (window.__zsDiagHooked) return () => {};
  window.__zsDiagHooked = true;

  const onError = (event) => {
    emit('error', 'renderer', event.message || 'Ошибка в интерфейсе', {
      source: `${event.filename || ''}:${event.lineno || 0}`,
      stack: String(event.error?.stack || '').slice(0, 1500),
    });
  };
  const onRejection = (event) => {
    const reason = event.reason;
    emit('error', 'renderer', 'Необработанный отказ промиса', {
      reason: String(reason?.message || reason).slice(0, 600),
      stack: String(reason?.stack || '').slice(0, 1500),
    });
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  emit('info', 'renderer', 'Интерфейс запущен', {
    keep: true,
    ua: navigator.userAgent.slice(0, 120),
  });

  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    window.__zsDiagHooked = false;
  };
}

export default diag;
