/** CI only: реальный SendInput в тестовое окно, затем подмена потери ответа.
 * Оба помощника и IPC настоящие; моделируется только отсутствие подтверждения. */
if (process.platform !== 'win32' || process.env.CI !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.ZS_INPUT_LOST_E2E !== '1') {
  throw new Error('Тест допускается только на изолированном Windows CI');
}
const { host } = require('../../electron/inputHost.cjs');
const type = host.type.bind(host);
host.type = async (text) => {
  const result = await type(text);
  if (!result.ok) throw new Error('Реальный тестовый SendInput не подтвердил ввод');
  return { ok: false, typed: 0, total: String(text).length, reason: 'simulated-lost-response', uncertain: true };
};
const winInput = require('../../electron/winInput.cjs');
const createWinInput = winInput.createWinInput;
winInput.createWinInput = (...args) => {
  const input = createWinInput(...args);
  return { ...input, paste: async () => {
    const result = await input.paste();
    if (!result.ok) throw new Error('Реальный тестовый Ctrl+V не подтвердил нажатие');
    return { ok: false, uncertain: true, reason: 'simulated-lost-response' };
  } };
};
require('./electron-entry.cjs');
