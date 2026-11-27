/**
 * Резидентный помощник ввода: один процесс PowerShell на всё приложение.
 *
 * Зачем он нужен. Вставка текста в чужое окно на Windows делалась так:
 * каждый раз запускался `powershell.exe`, внутри — `Add-Type`, который
 * компилирует C# на ходу, и только потом SendInput/SendKeys. Холодный старт
 * PowerShell с компиляцией — это сотни миллисекунд, а на слабом ПК с
 * антивирусом, который проверяет каждый новый процесс, — секунды. Причём
 * платили за это ДВА раза: сначала чтобы вставить Ctrl+V, потом (в режиме
 * «без буфера») чтобы напечатать сам текст.
 *
 * Здесь то же самое, но процесс поднимается один раз — при запуске
 * приложения и при старте записи (пока человек говорит, время бесплатное), и
 * дальше общается с нами построчно. Вставка после этого — единицы миллисекунд,
 * потому что С# уже скомпилирован, а PowerShell уже работает.
 *
 * Протокол (построчный, UTF-8):
 *   PING            → {"ok":true}
 *   PASTE           → {"ok":true}                  Ctrl+V в активное окно
 *   COPY            → {"ok":true}                  Ctrl+C в активном окне
 *   TYPE <base64>   → {"ok":true,"typed":N}        текст через SendInput
 *   TARGET          → {"ok":true,"title64":"…"}    заголовок активного окна
 *
 * Если процесс не поднялся, можно использовать прежний путь. После отправки
 * команды потеря ответа не доказывает, что ввод не состоялся: повтор опасен.
 */

const { spawn } = require('node:child_process');

const POWERSHELL = 'powershell.exe';

// C#: SendInput с UNICODE-сканкодами для текста и аккорды (Ctrl+клавиша).
const CS = String.raw`
using System;
using System.Runtime.InteropServices;

public static class ZsInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  // Полный union нужен даже для клавиатуры: MOUSEINPUT определяет размер
  // INPUT, который проверяет Windows (40 байт на x64, 28 на x86).
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION {
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public MOUSEINPUT mi;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public INPUTUNION u;
  }

  [DllImport("user32.dll", SetLastError = true)]
  static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  [DllImport("user32.dll")]
  static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int maxCount);

  // Заголовок активного окна: нужен интерфейсу, чтобы показать, куда попадёт
  // текст. Через уже запущенный процесс — без нового PowerShell на каждую фразу.
  public static string Title() {
    var buffer = new System.Text.StringBuilder(512);
    GetWindowText(GetForegroundWindow(), buffer, 512);
    return buffer.ToString();
  }

  const uint INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_UNICODE = 0x0004;

  static INPUT Key(ushort scan, ushort vk, uint flags) {
    INPUT one = new INPUT();
    one.type = INPUT_KEYBOARD;
    one.u.ki.wVk = vk;
    one.u.ki.wScan = scan;
    one.u.ki.dwFlags = flags;
    return one;
  }

  // Один юнит UTF-16: down + up, иначе повтор символа слипается.
  public static bool Unit(ushort code) {
    INPUT[] pair = new INPUT[2];
    pair[0] = Key(code, 0, KEYEVENTF_UNICODE);
    pair[1] = Key(code, 0, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
    int size = Marshal.SizeOf(typeof(INPUT));
    return SendInput(2, pair, size) == 2;
  }

  // Аккорд Ctrl + клавиша: модификатор жмём первым и отпускаем последним.
  public static bool Chord(ushort vk) {
    ushort ctrl = 0x11;
    INPUT[] seq = new INPUT[4];
    seq[0] = Key(0, ctrl, 0);
    seq[1] = Key(0, vk, 0);
    seq[2] = Key(0, vk, KEYEVENTF_KEYUP);
    seq[3] = Key(0, ctrl, KEYEVENTF_KEYUP);
    int size = Marshal.SizeOf(typeof(INPUT));
    return SendInput(4, seq, size) == 4;
  }
}
`;

const VK_V = 0x56;
const VK_C = 0x43;

/** Скрипт помощника. Вынесен отдельно: его проверяют тесты. */
function buildHostScript() {
  return String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
${CS}
"@

function Reply([string]$json) {
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

Reply '{"ok":true,"ready":true}'

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if (-not $line) { continue }
  $head = $line.Split(' ', 2)[0].ToUpperInvariant()
  try {
    switch ($head) {
      'PING' { Reply '{"ok":true}' }
      'PASTE' {
        $ok = [ZsInput]::Chord(${VK_V})
        Reply ('{"ok":' + $ok.ToString().ToLowerInvariant() + '}')
      }
      'COPY' {
        $ok = [ZsInput]::Chord(${VK_C})
        Reply ('{"ok":' + $ok.ToString().ToLowerInvariant() + '}')
      }
      'TARGET' {
        $title = [ZsInput]::Title()
        $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($title))
        Reply ('{"ok":true,"title64":"' + $b64 + '"}')
      }
      'TYPE' {
        $rest = ''
        if ($line.Length -gt 4) { $rest = $line.Substring(5).Trim() }
        $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($rest))
        $typed = 0
        $failed = $false
        foreach ($unit in $text.ToCharArray()) {
          if (-not [ZsInput]::Unit([uint16]$unit)) { $failed = $true; break }
          $typed++
        }
        $okJson = (-not $failed).ToString().ToLowerInvariant()
        Reply ('{"ok":' + $okJson + ',"typed":' + $typed + '}')
      }
      default { Reply '{"ok":false,"reason":"unknown-command"}' }
    }
  } catch {
    $msg = $_.Exception.Message -replace '"', "'" -replace '\r?\n', ' '
    Reply ('{"ok":false,"reason":"' + $msg + '"}')
  }
}
`;
}

/** PowerShell принимает скрипт в base64 от UTF-16LE — так нет проблем с кавычками. */
function encodeCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

class InputHost {
  constructor({ launch, platform = process.platform, timeoutMs = 2500 } = {}) {
    this.launch = launch || null;
    this.platform = platform;
    this.timeoutMs = timeoutMs;
    this.proc = null;
    this.retiring = null;
    this.ready = false;
    this.pending = [];
    this.buffer = '';
    this.failures = 0;
    this.retryAfter = 0;
    this.stats = { spawned: 0, requests: 0, failed: 0 };
  }

  /** Поддерживается ли платформа и есть ли чем запускать. */
  available() {
    return this.platform === 'win32' || typeof this.launch === 'function';
  }

  /**
   * Поднять процесс. Возвращает true, если он уже готов отвечать.
   * Повторные вызовы безопасны: второй процесс не запускается.
   */
  start() {
    if (this.proc) return true;
    if (this.retiring) return false;
    if (!this.available()) return false;
    if (Date.now() < this.retryAfter) return false;
    try {
      this.proc =
        typeof this.launch === 'function'
          ? this.launch()
          : spawn(POWERSHELL, [
              '-NoProfile',
              '-NonInteractive',
              '-WindowStyle',
              'Hidden',
              '-EncodedCommand',
              encodeCommand(buildHostScript()),
            ], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      this.proc = null;
      this.retryAfter = Date.now() + 10000;
      return false;
    }
    if (!this.proc) {
      this.retryAfter = Date.now() + 10000;
      return false;
    }
    this.stats.spawned += 1;
    this.buffer = '';
    const proc = this.proc;
    proc.stdout?.setEncoding?.('utf8');
    proc.stdout?.on?.('data', (chunk) => { if (this.proc === proc) this._onData(chunk); });
    proc.on?.('error', () => { if (this.proc === proc) this._abort('host-error'); });
    proc.on?.('close', () => this._onExit(proc));
    proc.on?.('exit', () => this._onExit(proc));
    return true;
  }

  _onExit(proc) {
    if (this.retiring === proc) { this.retiring = null; return; }
    if (this.proc !== proc) return; // позднее событие старого процесса
    const wasReady = this.ready;
    this.proc = null;
    this.ready = false;
    // Не отвеченные запросы нельзя оставлять висеть; команда могла исполниться.
    const pending = this.pending;
    this.pending = [];
    for (const item of pending) {
      this.stats.failed += 1;
      clearTimeout(item.timer);
      item.resolve({ ok: false, reason: 'host-exited' });
    }
    // Пауза перед повторным запуском: не плодим процессы, если PowerShell
    // запрещён политикой или падает при старте.
    this.failures = wasReady ? 0 : this.failures + 1;
    this.retryAfter = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(4, this.failures));
  }

  // При потере порядка ответов закрываем весь поток команд. Результат любого
  // уже отправленного запроса неизвестен; ожидание завершения процесса не
  // доказывает, что он не успел нажать клавиши.
  _abort(reason, timedOut) {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    this.retiring = proc;
    this.ready = false;
    this.buffer = '';
    const pending = this.pending;
    this.pending = [];
    for (const item of pending) {
      this.stats.failed += 1;
      clearTimeout(item.timer);
      item.resolve({ ok: false, reason: item === timedOut ? reason : 'host-aborted' });
    }
    try { proc.kill?.(); } catch { /* блокируем запуск, пока не придёт exit */ }
  }

  _onData(chunk) {
    this.buffer += String(chunk);
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '').trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this._onLine(line);
      index = this.buffer.indexOf('\n');
    }
    // Защита от мусора без переводов строки.
    if (this.buffer.length > 65536) this.buffer = '';
  }

  _onLine(line) {
    let data = null;
    try {
      data = JSON.parse(line);
    } catch {
      return; // служебный вывод PowerShell — не наш ответ
    }
    if (!this.ready && data && data.ready) {
      this.ready = true;
      this.failures = 0;
      return;
    }
    const item = this.pending.shift();
    if (!item) return;
    clearTimeout(item.timer);
    item.resolve(data && typeof data === 'object' ? data : { ok: false, reason: 'bad-response' });
  }

  /** Отправить команду и дождаться ответа. Никогда не бросает. */
  request(command) {
    if (!this.start()) return Promise.resolve({ ok: false, reason: this.retiring ? 'host-restarting' : 'host-not-started' });
    this.stats.requests += 1;
    return new Promise((resolve) => {
      const item = { resolve, timer: null };
      item.timer = setTimeout(() => this._abort('timeout', item), this.timeoutMs);
      this.pending.push(item);
      try {
        this.proc.stdin.write(`${command}\n`);
      } catch {
        // Даже исключение записи не гарантирует, что команда не дошла.
        this._abort('write-failed', item);
      }
    });
  }

  /** Ctrl+V в активное окно. */
  paste() {
    return this.request('PASTE');
  }

  /** Ctrl+C в активном окне. */
  copy() {
    return this.request('COPY');
  }

  /** Заголовок активного окна (куда попадёт текст). */
  target() {
    return this.request('TARGET').then((res) => {
      if (!res?.ok) return { ok: false, title: '' };
      let title = '';
      try {
        title = Buffer.from(String(res.title64 || ''), 'base64').toString('utf8');
      } catch {
        title = '';
      }
      return { ok: true, title };
    });
  }

  /** Напечатать текст через SendInput. */
  type(text) {
    const value = String(text || '');
    if (!value) return Promise.resolve({ ok: false, typed: 0, reason: 'empty' });
    const encoded = Buffer.from(value, 'utf8').toString('base64');
    return this.request(`TYPE ${encoded}`).then((res) => {
      const typed = Number.isInteger(res?.typed) && res.typed >= 0 && res.typed <= value.length ? res.typed : 0;
      const ok = res?.ok === true && typed === value.length;
      return { ok, typed, total: value.length, reason: res?.reason || '',
        // Только отказ запуска гарантирует, что команда не отправлялась.
        uncertain: !ok && res?.reason !== 'host-not-started' };
    });
  }

  status() {
    return {
      available: this.available(),
      running: Boolean(this.proc),
      ready: Boolean(this.ready),
      spawned: this.stats.spawned,
      requests: this.stats.requests,
      failed: this.stats.failed,
    };
  }

  stop() {
    this._abort('host-stopped');
  }
}

const host = new InputHost();

module.exports = { InputHost, host, buildHostScript, encodeCommand, POWERSHELL };
