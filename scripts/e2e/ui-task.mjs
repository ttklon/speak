/** Bound one UI phase. A timeout is fatal: the caller must stop the run and
 * close the browser, because Promise.race cannot cancel a stuck operation. */
export class UiTaskTimeout extends Error {
  constructor(name, timeoutMs) {
    super(`UI task ${name} exceeded timeout (${timeoutMs} ms)`);
    this.name = 'UiTaskTimeout';
  }
}

export async function runUiTask(name, task, { timeoutMs = 180_000, log = console.log } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid UI task timeout');
  log(`▶ ${name}`);
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new UiTaskTimeout(name, timeoutMs)), timeoutMs); }),
    ]);
    log(`◀ ${name} (завершено)`);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/** Preserve the existing policy: record ordinary failures and continue, but
 * stop after timeout because the abandoned task can still use the browser. */
export async function runUiScenario(name, task, onError, options) {
  try {
    await runUiTask(name, task, options);
  } catch (err) {
    onError(err);
    if (err instanceof UiTaskTimeout) throw err;
  }
}
