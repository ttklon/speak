/** CI only: реальный SendInput в тестовое окно, затем подмена потери ответа.
 * Сам помощник и IPC настоящие; моделируется только отсутствие подтверждения. */
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
require('./electron-entry.cjs');
