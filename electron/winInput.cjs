/**
 * Вставка текста в активное окно на Windows — без PowerShell.
 *
 * Почему это переписано. Раньше единственным путём ввода были PowerShell-скрипты:
 * `Add-Type -AssemblyName System.Windows.Forms; [SendKeys]::SendWait('^v')` и
 * `SendInput` через `Add-Type`. Это работало не у всех: политика PowerShell
 * (ExecutionPolicy, ConstrainedLanguage, AppLocker), антивирус, который
 * проверяет каждый новый powershell.exe, или отсутствие Windows Forms в
 * урезанной сборке — и вставка молча не происходила. Человек при этом видел
 * уведомление «Готово», потому что распознавание сработало, а вставлять было
 * нечем.
 *
 * Здесь тот же SendInput, но собранный в отдельный маленький exe:
 *   1. при первом использовании C# компилируется `csc.exe` — он есть в составе
 *      .NET Framework, то есть в любой Windows 10/11, ставить ничего не нужно;
 *   2. дальше каждое нажатие — запуск своего exe (~20–40 мс) без PowerShell,
 *      без `Add-Type`, без политик.
 *
 * Что важно по существу SendInput:
 *   - текст отправляется с KEYEVENTF_UNICODE по одному символу в отдельном
 *     вызове: часть приложений (в том числе Блокнот в Windows 11) портит
 *     символы, если отправить их пачкой;
 *   - Ctrl+V отправляется скан-кодами, поэтому работает независимо от раскладки;
 *   - в приложения, запущенные от администратора, ввод не пройдёт (UIPI) — это
 *     ограничение Windows, и интерфейс должен сказать об этом прямо, а не
 *     делать вид, что всё вставилось.
 *
 * Модуль отдаёт честный результат: `{ok, typed, total, reason}`. Никаких
 * «наверное, сработало».
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

/** Версия помощника: меняем текст программы — меняем версию. */
const HELPER_VERSION = '3';

// C# под .NET Framework 4 (csc.exe — это C# 5): без интерполяции строк и
// прочих новых возможностей, иначе старый компилятор не поймёт.
const CS_SOURCE = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class ZsInput
{
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT
  {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION
  {
    [FieldOffset(0)] public KEYBDINPUT ki;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT
  {
    public uint type;
    public INPUTUNION u;
  }

  [DllImport("user32.dll", SetLastError = true)]
  static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  [DllImport("user32.dll")]
  static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

  const uint INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_UNICODE = 0x0004;
  const ushort VK_CONTROL = 0x11;
  const ushort VK_RETURN = 0x0D;
  const ushort VK_TAB = 0x09;
  const ushort VK_V = 0x56;

  static INPUT Unicode(ushort scan, bool up)
  {
    INPUT one = new INPUT();
    one.type = INPUT_KEYBOARD;
    one.u.ki.wScan = scan;
    one.u.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0);
    return one;
  }

  static INPUT Virtual(ushort vk, bool up)
  {
    INPUT one = new INPUT();
    one.type = INPUT_KEYBOARD;
    one.u.ki.wVk = vk;
    one.u.ki.wScan = 0;
    one.u.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
    return one;
  }

  static bool Send(INPUT[] batch)
  {
    uint sent = SendInput((uint)batch.Length, batch, Marshal.SizeOf(typeof(INPUT)));
    return sent == batch.Length;
  }

  // Один символ — один вызов SendInput. Пачка портит текст в части приложений.
  static int TypeText(string text)
  {
    int typed = 0;
    for (int i = 0; i < text.Length; i++)
    {
      char ch = text[i];
      bool ok;
      if (ch == '\n')
      {
        ok = Send(new INPUT[] { Virtual(VK_RETURN, false), Virtual(VK_RETURN, true) });
        typed++;
      }
      else if (ch == '\t')
      {
        ok = Send(new INPUT[] { Virtual(VK_TAB, false), Virtual(VK_TAB, true) });
        typed++;
      }
      else if (ch == '\r')
      {
        continue;
      }
      else
      {
        // Суррогатная пара: оба символа уходят по отдельности, как и требует
        // KEYEVENTF_UNICODE.
        ushort scan = (ushort)ch;
        ok = Send(new INPUT[] { Unicode(scan, false), Unicode(scan, true) });
        typed++;
      }
      if (!ok) break;
      Thread.Sleep(1);
    }
    return typed;
  }

  static bool Paste()
  {
    INPUT[] combo = new INPUT[]
    {
      Virtual(VK_CONTROL, false),
      Virtual(VK_V, false),
      Virtual(VK_V, true),
      Virtual(VK_CONTROL, true)
    };
    return Send(combo);
  }

  static string Title()
  {
    StringBuilder buffer = new StringBuilder(512);
    GetWindowText(GetForegroundWindow(), buffer, 512);
    return buffer.ToString();
  }

  static string J(string value)
  {
    if (value == null) return "null";
    StringBuilder sb = new StringBuilder("\"");
    for (int i = 0; i < value.Length; i++)
    {
      char c = value[i];
      if (c == '\\' || c == '"') { sb.Append('\\'); sb.Append(c); }
      else if (c == '\n') sb.Append("\\n");
      else if (c == '\r') sb.Append("\\r");
      else if (c == '\t') sb.Append("\\t");
      else if (c < ' ') sb.Append(' ');
      else sb.Append(c);
    }
    sb.Append("\"");
    return sb.ToString();
  }

  public static int Main(string[] args)
  {
    try
    {
      string command = args.Length > 0 ? args[0] : "";
      if (command == "ping" || command == "target")
      {
        Console.OutputEncoding = Encoding.UTF8;
        Console.WriteLine("{\"ok\":true,\"target\":" + J(Title()) + "}");
        return 0;
      }
      if (command == "paste")
      {
        bool ok = Paste();
        Console.WriteLine(ok ? "{\"ok\":true}" : "{\"ok\":false,\"reason\":\"sendinput-failed\"}");
        return ok ? 0 : 1;
      }
      if (command == "type")
      {
        string base64 = args.Length > 1 ? args[1] : "";
        string text = Encoding.UTF8.GetString(Convert.FromBase64String(base64));
        int typed = TypeText(text);
        bool complete = typed == text.Length;
        Console.WriteLine("{\"ok\":" + (complete ? "true" : "false") + ",\"typed\":" + typed + ",\"total\":" + text.Length + "}");
        return complete ? 0 : 1;
      }
      Console.WriteLine("{\"ok\":false,\"reason\":\"unknown-command\"}");
      return 2;
    }
    catch (Exception error)
    {
      Console.WriteLine("{\"ok\":false,\"reason\":" + J(error.Message) + "}");
      return 3;
    }
  }
}
`;

/** Где Windows держит компилятор C# из состава .NET Framework. */
function candidateCompilers() {
  const roots = [process.env.WINDIR || 'C:\\Windows', 'C:\\Windows'];
  const versions = ['v4.0.30319', 'v3.5'];
  const list = [];
  for (const root of roots) {
    for (const bitness of ['Framework64', 'Framework']) {
      for (const version of versions) {
        list.push(path.join(root, 'Microsoft.NET', bitness, version, 'csc.exe'));
      }
    }
  }
  return list;
}

function findCompiler(exists = fs.existsSync) {
  for (const candidate of candidateCompilers()) {
    try {
      if (exists(candidate)) return candidate;
    } catch {
      /* путь может быть недоступен — проверяем следующий */
    }
  }
  return '';
}

/** Каталог, где лежит собранный помощник. */
function helperDir(baseDir) {
  return path.join(baseDir || path.join(os.homedir(), 'AppData', 'Local', 'ZSpeakly'), 'bin');
}

function helperPaths(baseDir) {
  const dir = helperDir(baseDir);
  const exe = path.join(dir, 'zs-input.exe');
  return { dir, exe, stamp: path.join(dir, 'zs-input.version'), source: path.join(dir, 'zs-input.cs') };
}

function parseHelperOutput(stdout = '') {
  const text = String(stdout || '').trim();
  if (!text) return { ok: false, reason: 'нет ответа от помощника' };
  // Берём последнюю строку: csc или сам exe могли что-то напечатать раньше.
  const line = text.split(/\r?\n/).filter(Boolean).pop() || '';
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    /* не JSON — ниже вернём причину */
  }
  return { ok: false, reason: `непонятный ответ: ${line.slice(0, 120)}` };
}

function createWinInput({ baseDir, platform = process.platform, exists = fs.existsSync, timeoutMs = 6000 } = {}) {
  const paths = helperPaths(baseDir);
  let state = { ready: false, reason: 'не проверяли', compiler: '', path: paths.exe };

  const isWindows = platform === 'win32';

  function compile(compiler) {
    return new Promise((resolve) => {
      try {
        fs.mkdirSync(paths.dir, { recursive: true });
        fs.writeFileSync(paths.source, CS_SOURCE, 'utf8');
      } catch (error) {
        resolve({ ok: false, reason: `нет доступа к папке помощника: ${error.message}` });
        return;
      }
      execFile(
        compiler,
        [
          '/nologo',
          '/target:exe',
          '/optimize+',
          '/platform:anycpu',
          `/out:${paths.exe}`,
          paths.source,
        ],
        { windowsHide: true, timeout: 60000 },
        (error, _stdout, stderr) => {
          if (error || !exists(paths.exe)) {
            resolve({
              ok: false,
              reason: `не удалось собрать помощник: ${String(stderr || error?.message || '').slice(0, 200)}`,
            });
            return;
          }
          try {
            fs.writeFileSync(paths.stamp, HELPER_VERSION, 'utf8');
          } catch {
            /* штамп не критичен */
          }
          resolve({ ok: true });
        },
      );
    });
  }

  async function ensure() {
    if (!isWindows) {
      state = { ...state, ready: false, reason: 'вставка через SendInput есть только в Windows' };
      return state;
    }
    let stamp = '';
    try {
      stamp = fs.readFileSync(paths.stamp, 'utf8').trim();
    } catch {
      stamp = '';
    }
    if (exists(paths.exe) && stamp === HELPER_VERSION) {
      state = { ...state, ready: true, reason: '' };
      return state;
    }
    const compiler = findCompiler(exists);
    if (!compiler) {
      state = {
        ...state,
        ready: false,
        reason: 'не нашёлся csc.exe (.NET Framework) — останется вставка через буфер',
      };
      return state;
    }
    const built = await compile(compiler);
    state = built.ok
      ? { ready: true, reason: '', compiler, path: paths.exe }
      : { ready: false, reason: built.reason, compiler, path: paths.exe };
    return state;
  }

  function run(args) {
    return new Promise((resolve) => {
      if (!isWindows) {
        resolve({ ok: false, reason: 'только Windows' });
        return;
      }
      if (!exists(paths.exe)) {
        resolve({ ok: false, reason: 'помощник ввода не собран' });
        return;
      }
      let child;
      try {
        child = spawn(paths.exe, args, { windowsHide: true });
      } catch (error) {
        resolve({ ok: false, reason: String(error?.message || error) });
        return;
      }
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* уже завершился */
        }
        resolve({ ok: false, reason: 'помощник не ответил вовремя' });
      }, timeoutMs);
      child.stdout?.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: String(error?.message || error) });
      });
      child.on('close', () => {
        clearTimeout(timer);
        const parsed = parseHelperOutput(stdout);
        if (!parsed.ok && !parsed.reason && stderr) parsed.reason = String(stderr).slice(0, 200);
        resolve(parsed);
      });
    });
  }

  return {
    paths,
    status: () => ({ ...state, platform }),
    ensure,
    /** Напечатать текст в активное окно. */
    type(text) {
      const value = String(text || '');
      if (!value) return Promise.resolve({ ok: true, typed: 0, total: 0 });
      return run(['type', Buffer.from(value, 'utf8').toString('base64')]);
    },
    /** Нажать Ctrl+V в активном окне (текст уже должен быть в буфере). */
    paste: () => run(['paste']),
    /** Заголовок активного окна — чтобы показать, куда попадёт текст. */
    target: () => run(['target']),
    ping: () => run(['ping']),
  };
}

module.exports = { createWinInput, findCompiler, candidateCompilers, helperPaths, parseHelperOutput, HELPER_VERSION };
