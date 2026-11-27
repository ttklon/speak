/** Только тестовый запуск: отдельный профиль и запрет фоновых загрузок.
 * Основной процесс, preload, IPC, аудио и ONNX не подменяются. */
const { app } = require('electron');
if (!process.env.ZS_E2E_PROFILE) throw new Error('Не задан временный профиль');
app.setPath('userData', process.env.ZS_E2E_PROFILE);
// В тесте модели уже загружены и проверены; автозагрузка Windows whisper.cpp
// на Linux-раннере не относится к проверке и не должна ходить в интернет.
const models = require('../../electron/models.cjs');
for (const name of ['downloadEngine', 'downloadModel', 'downloadVad']) {
  models[name] = async () => ({ ok: false, reason: 'автозагрузка отключена тестом' });
}
require('../../electron/main.cjs');
