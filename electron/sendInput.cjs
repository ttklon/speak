/**
 * Ввод текста через Win32 SendInput без буфера обмена.
 *
 * Зачем: вставка через буфер + Ctrl+V затирает чужой буфер (мы его возвращаем,
 * но на полсекунды он всё же занят) и не работает в полях, где Ctrl+V
 * перехвачен (терминалы, часть игр и RDP-сессий). SendInput шлёт клавиатурные
 * события с UNICODE-сканкодами прямо в активное окно.
 *
 * Реализовано через PowerShell + Add-Type: нативного модуля в сборке нет, а
 * тянуть robotjs/nut.js — это отдельная сборка под каждую версию Electron.
 *
 * Честность важнее удобства: скрипт печатает прогресс, и если SendInput успел
 * отправить только часть символов, вызывающий код обязан НЕ повторять вставку
 * через буфер — иначе текст задвоится. Поэтому sendUnicodeText возвращает
 * точное число отправленных символов.
 */

const WINDOWS_ONLY = 'win32';

// Скрипт читает base64 с текстом из stdin, отправляет символы и печатает
// машинно-читаемый прогресс. Никаких аргументов командной строки с текстом —
// иначе диктовка попала бы в список процессов.
const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class ZsSendInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION {
    [FieldOffset(0)] public KEYBDINPUT ki;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public INPUTUNION u;
  }

  [DllImport("user32.dll", SetLastError = true)]
  static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  const uint INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_UNICODE = 0x0004;

  // Один юнит UTF-16: down + up, иначе повтор символа слипается.
  public static bool TypeUnit(ushort unit) {
    INPUT[] pair = new INPUT[2];
    pair[0].type = INPUT_KEYBOARD;
    pair[0].u.ki.wVk = 0;
    pair[0].u.ki.wScan = unit;
    pair[0].u.ki.dwFlags = KEYEVENTF_UNICODE;
    pair[1].type = INPUT_KEYBOARD;
    pair[1].u.ki.wVk = 0;
    pair[1].u.ki.wScan = unit;
    pair[1].u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
    int size = Marshal.SizeOf(typeof(INPUT));
    return SendInput(2, pair, size) == 2;
  }
}
"@

$raw = [Console]::In.ReadToEnd()
if (-not $raw) { Write-Output 'err:empty'; exit 3 }
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($raw.Trim()))
if (-not $text) { Write-Output 'err:empty'; exit 3 }

$sent = 0
foreach ($unit in $text.ToCharArray()) {
  if (-not [ZsSendInput]::TypeUnit([uint16]$unit)) {
    Write-Output ("err:sendinput " + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
    Write-Output ("p:" + $sent)
    exit 2
  }
  $sent++
  # прогресс каждые 25 символов: по нему видно, где именно ввод оборвался
  if ($sent % 25 -eq 0) { Write-Output ("p:" + $sent) }
}
Write-Output ("ok:" + $sent)
`;

/** Скрипт целиком — вынесен для тестов: он должен действительно звать SendInput. */
function buildScript() {
  return PS_SCRIPT.trim();
}

/**
 * Разбор вывода скрипта. Возвращает число отправленных символов и статус.
 * @param {string} out
 * @param {number} total
 */
function parseOutput(out, total) {
  const lines = String(out || '').split(/\r?\n/).filter(Boolean);
  let sent = 0;
  let ok = false;
  let reason = '';
  for (const line of lines) {
    if (line.startsWith('p:')) {
      const n = Number(line.slice(2));
      if (Number.isFinite(n) && n > sent) sent = n;
    } else if (line.startsWith('ok:')) {
      const n = Number(line.slice(3));
      if (Number.isFinite(n)) sent = n;
      ok = true;
    } else if (line.startsWith('err:')) {
      reason = line.slice(4).trim() || 'sendinput';
    }
  }
  if (ok && total > 0 && sent !== total) ok = false;
  return { ok, sent, reason };
}

/**
 * Отправляет текст в активное окно SendInput'ом.
 *
 * @param {object} opts
 * @param {string} opts.text
 * @param {(file:string, args:string[], opts:object, cb:Function)=>void} opts.execFile
 *   передаётся из main — в тестах подменяется, чтобы процесс был виртуальным
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.platform]
 * @returns {Promise<{ok:boolean, sent:number, total:number, reason:string, skipped?:boolean}>}
 */
function sendUnicodeText({ text, execFile, timeoutMs = 20000, platform = process.platform } = {}) {
  const value = String(text || '');
  const total = value.length;
  if (!value) return Promise.resolve({ ok: false, sent: 0, total: 0, reason: 'empty' });
  if (platform !== WINDOWS_ONLY) {
    // На других системах честно говорим, что приём недоступен, — вызывающий
    // код откатится на буфер, а не сделает вид, что ввёл текст.
    return Promise.resolve({ ok: false, sent: 0, total, reason: 'windows-only', skipped: true });
  }
  if (typeof execFile !== 'function') {
    return Promise.resolve({ ok: false, sent: 0, total, reason: 'no-exec' });
  }

  const child = execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', buildScript()],
    { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
    () => {},
  );

  return new Promise((resolve) => {
    let collected = '';
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };
    const text64 = Buffer.from(value, 'utf8').toString('base64');
    try {
      child.stdin?.write?.(text64);
      child.stdin?.end?.();
    } catch {
      /* ниже разберём вывод и решим */
    }
    child.stdout?.on?.('data', (d) => {
      collected += String(d);
    });
    child.on?.('error', (err) => {
      finish({ ok: false, sent: 0, total, reason: String(err?.message || err) });
    });
    child.on?.('close', (code) => {
      const parsed = parseOutput(collected, total);
      finish({
        ok: parsed.ok && code === 0,
        sent: parsed.sent,
        total,
        reason: parsed.reason || (code === 0 ? '' : `exit ${code}`),
      });
    });
  });
}

module.exports = { buildScript, parseOutput, sendUnicodeText };
