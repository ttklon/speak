'use strict';
// Backport electron-builder #9769 (a356198): SHGetKnownFolderPath allocates a
// short string; reading NSIS_MAX_STRLEN chars from it can crash on first install.
// afterPack runs before NSIS compilation, including direct electron-builder use.
const fs = require('node:fs');
const path = require('node:path');

const unsafe = `      System::Store S
      # Win7 has a per-user programfiles known folder and this can be a non-default location
      System::Call 'SHELL32::SHGetKnownFolderPath(g "\${FOLDERID_UserProgramFiles}", i \${KF_FLAG_CREATE}, p 0, *p .r2)i.r1'
      \${If} $1 == 0
        System::Call '*$2(&w\${NSIS_MAX_STRLEN} .s)'
        StrCpy $0 $1
        System::Call 'OLE32::CoTaskMemFree(p r2)'
      \${endif}
      System::Store L`;
const safe = `      Push $1
      Push $2
      # UserProgramFiles can be redirected; copy only up to the terminating NUL.
      StrCpy $2 0
      System::Call 'SHELL32::SHGetKnownFolderPath(g "\${FOLDERID_UserProgramFiles}", i \${KF_FLAG_CREATE}, p 0, *p .r2)i.r1'
      \${If} $1 == 0
        System::Call 'KERNEL32::lstrcpynW(w .r0, p r2, i \${NSIS_MAX_STRLEN})p'
      \${endif}
      # The shell may allocate memory even on failure.
      \${If} $2 != 0
        System::Call 'OLE32::CoTaskMemFree(p r2)'
      \${endif}
      Pop $2
      Pop $1`;
function patch(contents) {
  if (contents.includes(unsafe)) {
    const result = contents.replace(unsafe, safe);
    if (result.includes(unsafe)) throw new Error('NSIS template contains multiple unsafe blocks');
    return result;
  }
  if (contents.includes(safe) && !contents.includes("System::Call '*$2(&w${NSIS_MAX_STRLEN} .s)'")) return contents;
  throw new Error('NSIS template changed; review the UserProgramFiles safety backport');
}
async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const filename = path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates', 'nsis', 'multiUser.nsh');
  const original = fs.readFileSync(filename, 'utf8');
  const updated = patch(original);
  if (updated !== original) fs.writeFileSync(filename, updated, 'utf8');
  console.log('NSIS: bounded UserProgramFiles copy (electron-builder #9769)');
}
module.exports = afterPack;
module.exports.patch = patch;
