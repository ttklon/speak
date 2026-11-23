/** Только изолированный Windows CI: реальный Ctrl+V, затем удерживаем ответ
 * помощника, чтобы второй запрос точно пришёл, пока первый ещё выполняется. */
if (process.platform !== 'win32' || process.env.CI !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.ZS_CONCURRENT_E2E !== '1' ||
    !process.env.ZS_CONCURRENT_DIR) {
  throw new Error('Тест допускается только на изолированном Windows CI');
}
const fs = require('node:fs');
const path = require('node:path');
const directory = process.env.ZS_CONCURRENT_DIR;
const winInput = require('../../electron/winInput.cjs');
const createWinInput = winInput.createWinInput;
let held = false;
winInput.createWinInput = (...args) => {
  const input = createWinInput(...args);
  return { ...input, paste: async () => {
    const result = await input.paste();
    if (!held) {
      held = true;
      if (!result.ok) throw new Error('Реальный Ctrl+V не подтвердил нажатие');
      fs.writeFileSync(path.join(directory, 'concurrent-paste-ready'), 'ready');
      const release = path.join(directory, 'concurrent-paste-release');
      const deadline = Date.now() + 20000;
      while (!fs.existsSync(release)) {
        if (Date.now() >= deadline) throw new Error('тест не освободил ответ');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    return result;
  } };
};
require('./electron-entry.cjs');
