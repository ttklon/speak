/**
 * Скачивание файлов моделей с проверкой целостности — общее для всех движков.
 *
 * Зачем отдельным модулем: у нас уже два движка со своими моделями (русская и
 * европейская), и у обоих одна и та же опасность — оборванная загрузка,
 * выглядящая как готовая модель. Правило простое и одно на всех:
 *
 *   файл пишется с суффиксом `.unverified` и получает настоящее имя только
 *   после того, как совпали размер и SHA-256 из закреплённого манифеста.
 *
 * Ничего специфичного для языков здесь нет: размер, хеш, прогресс, отмена.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

/** Удалить файл, не падая на его отсутствии. */
function safeUnlink(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* файла нет — и хорошо */
  }
}

/** SHA-256 файла целиком, потоком: модели весят сотни мегабайт. */
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Скачать один файл с поддержкой перенаправлений (Hugging Face отдаёт LFS с другого хоста). */
function downloadFile(url, destination, onBytes, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error('слишком много перенаправлений'));
      return;
    }
    const client = url.startsWith('http:') ? http : https;
    const request = client.get(url, { headers: { 'User-Agent': 'ZSpeakly' }, timeout: 30000 }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, url).toString();
        downloadFile(next, destination, onBytes, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`сервер модели ответил ${response.statusCode}`));
        return;
      }
      const sink = fs.createWriteStream(destination);
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        onBytes(bytes);
      });
      response.pipe(sink);
      sink.on('error', reject);
      response.on('error', reject);
      sink.on('finish', () => resolve(bytes));
    });
    request.on('timeout', () => request.destroy(new Error('сервер модели не ответил')));
    request.on('error', reject);
  });
}

/**
 * Докачать недостающие файлы модели.
 *
 * Уже лежащие на месте файлы не трогаются: прерванная загрузка продолжается с
 * того места, где остановилась, а не с нуля (это сотни мегабайт).
 *
 * @param {object} input
 * @param {string} input.dir папка модели
 * @param {Array<{ name: string, size: number, sha256: string }>} input.files манифест
 * @param {string} input.baseUrl адрес, откуда качать
 * @param {string[]} input.missing имена файлов, которых не хватает
 * @param {{ cancelled: boolean, received: number, total: number }} input.state флажок отмены
 * @param {(state: { received: number, total: number, file: string }) => void} [input.onProgress]
 */
async function downloadFiles({ dir, files, baseUrl, missing, state, onProgress }) {
  const total = files.reduce((sum, file) => sum + file.size, 0);
  fs.mkdirSync(dir, { recursive: true });
  const queue = files.filter((file) => missing.includes(file.name));
  let received = total - queue.reduce((sum, file) => sum + file.size, 0);
  state.total = total;
  state.received = received;
  try {
    for (const file of queue) {
      if (state.cancelled) throw new Error('скачивание отменено');
      const destination = path.join(dir, file.name);
      const temporary = `${destination}.unverified`;
      await downloadFile(`${baseUrl}/${file.name}`, temporary, (bytes) => {
        state.received = received + bytes;
        onProgress?.({ received: state.received, total, file: file.name });
      });
      if (state.cancelled) {
        safeUnlink(temporary);
        throw new Error('скачивание отменено');
      }
      const actual = await hashFile(temporary);
      if (actual !== file.sha256) {
        safeUnlink(temporary);
        throw new Error(`файл ${file.name} пришёл повреждённым`);
      }
      fs.renameSync(temporary, destination);
      received += file.size;
      state.received = received;
      onProgress?.({ received, total, file: file.name });
    }
  } finally {
    // Недокачанные файлы не должны оставаться на диске под видом модели.
    for (const file of files) safeUnlink(path.join(dir, `${file.name}.unverified`));
  }
  return { total, received };
}

module.exports = { downloadFile, downloadFiles, hashFile, safeUnlink };
