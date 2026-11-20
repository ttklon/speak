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
const { pipeline } = require('node:stream/promises');

/** Удалить файл, не падая на его отсутствии. */
function safeUnlink(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* файла нет — и хорошо */
  }
}

/** SHA-256 файла целиком, потоком: модели весят сотни мегабайт. */
function hashFile(file, signal) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file, { signal });
    let error;
    let ended = false;
    stream.on('error', (err) => { error = err; });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => { ended = true; });
    // Ждём закрытия файла перед удалением или переименованием (важно на Windows).
    stream.on('close', () => {
      if (error) reject(error);
      else if (!ended) reject(new Error('не удалось прочитать файл модели'));
      else resolve(hash.digest('hex'));
    });
  });
}

/** Скачать один файл с поддержкой перенаправлений и отмены. */
function downloadFile(url, destination, onBytes, redirects = 0, { signal, maxBytes } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error('слишком много перенаправлений'));
      return;
    }
    const client = url.startsWith('http:') ? http : https;
    let responseStarted = false;
    const request = client.get(url, { headers: { 'User-Agent': 'ZSpeakly' }, timeout: 30000, signal }, (response) => {
      responseStarted = true;
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        let next;
        try {
          const location = new URL(response.headers.location, url);
          if (!['http:', 'https:'].includes(location.protocol)) throw new Error('неподдерживаемый протокол');
          next = location.toString();
        } catch {
          reject(new Error('неверный адрес перенаправления'));
          return;
        }
        downloadFile(next, destination, onBytes, redirects + 1, { signal, maxBytes }).then(resolve, reject);
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
        if (maxBytes != null && bytes > maxBytes) {
          response.destroy(new Error('неверный размер файла модели'));
          return;
        }
        try {
          onBytes?.(bytes);
        } catch (err) {
          response.destroy(err);
        }
      });
      // pipeline дожидается закрытия обоих потоков даже при отмене и ошибке:
      // на Windows иначе временный файл может остаться открытым и не удалиться.
      pipeline(response, sink, { signal }).then(() => resolve(bytes), reject);
    });
    request.on('timeout', () => request.destroy(new Error('сервер модели не ответил')));
    // После начала ответа за завершение и закрытие файлов отвечает pipeline.
    request.on('error', (err) => { if (!responseStarted) reject(err); });
  });
}

/**
 * Докачать недостающие файлы модели.
 *
 * Файлы, которые вызывающий код считает имеющимися, не скачиваются повторно.
 * Незавершённый файл удаляется и при повторной попытке скачивается с начала.
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
  const controller = new AbortController();
  state.abort = () => controller.abort();
  try {
    for (const file of queue) {
      if (state.cancelled) throw new Error('скачивание отменено');
      const destination = path.join(dir, file.name);
      const temporary = `${destination}.unverified`;
      let nextProgressAt = 0;
      const size = await downloadFile(`${baseUrl}/${file.name}`, temporary, (bytes) => {
        state.received = received + bytes;
        // Не отправляем событие в интерфейс на каждый сетевой пакет: у большой
        // модели их тысячи. Первое и последнее обновление всегда показываются.
        const now = Date.now();
        if (now >= nextProgressAt) {
          nextProgressAt = now + 200;
          onProgress?.({ received: state.received, total, file: file.name });
        }
      }, 0, { signal: controller.signal, maxBytes: file.size });
      if (size !== file.size) throw new Error(`неверный размер файла ${file.name}`);
      if (state.cancelled) {
        safeUnlink(temporary);
        throw new Error('скачивание отменено');
      }
      const actual = await hashFile(temporary, controller.signal);
      if (state.cancelled) throw new Error('скачивание отменено');
      if (actual !== file.sha256) {
        safeUnlink(temporary);
        throw new Error(`файл ${file.name} пришёл повреждённым`);
      }
      fs.renameSync(temporary, destination);
      received += file.size;
      state.received = received;
      onProgress?.({ received, total, file: file.name });
    }
  } catch (err) {
    if (state.cancelled) throw new Error('скачивание отменено');
    throw err;
  } finally {
    delete state.abort;
    // Недокачанные файлы не должны оставаться на диске под видом модели.
    for (const file of files) safeUnlink(path.join(dir, `${file.name}.unverified`));
  }
  return { total, received };
}

module.exports = { downloadFile, downloadFiles, hashFile, safeUnlink };
