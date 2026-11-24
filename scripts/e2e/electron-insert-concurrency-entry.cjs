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
const kind = process.env.ZS_CONCURRENT_KIND || 'dictation';
if (!['dictation', 'selection'].includes(kind)) throw new Error('неизвестный режим теста');
let held = false;
async function holdFirst(result) {
  if (!held) {
    held = true;
    if (!result.ok) throw new Error('Реальный Ctrl+V не подтвердил нажатие');
    fs.writeFileSync(path.join(directory, `concurrent-${kind}-ready`), 'ready');
    const release = path.join(directory, `concurrent-${kind}-release`);
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(release)) {
      if (Date.now() >= deadline) throw new Error('тест не освободил ответ');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  return result;
}
if (kind === 'dictation') {
  const winInput = require('../../electron/winInput.cjs');
  const createWinInput = winInput.createWinInput;
  winInput.createWinInput = (...args) => {
    const input = createWinInput(...args);
    return { ...input, paste: async () => holdFirst(await input.paste()) };
  };
} else {
  const { host } = require('../../electron/inputHost.cjs');
  const paste = host.paste.bind(host);
  host.paste = async () => holdFirst(await paste());
}
require('./electron-entry.cjs');
