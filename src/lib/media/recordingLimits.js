// Превентивная остановка оставляет запас под финальный фрагмент MediaRecorder.
// Это предел накопленных данных, а не предел всей памяти процесса/кодека.
export const RECORDING_STOP_BYTES = 48 * 1024 * 1024;
export const RECORDING_MAX_BYTES = 64 * 1024 * 1024;
export const RECORDING_MAX_DURATION_MS = 10 * 60 * 1000;
