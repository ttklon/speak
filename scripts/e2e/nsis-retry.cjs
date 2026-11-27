'use strict';

// Only the known crash before a window was observed may be retried. A window
// can appear and vanish between polling intervals, so this is not proof that
// no window ever existed. An installed executable always blocks a retry.
function mayRetryOldInstaller({ status, stdout = '', stderr = '', exeExists }) {
  return status !== 0 &&
    String(stderr).includes('Installer exited with code -1073741819') &&
    !String(stdout).includes('Wizard window observed') &&
    !String(stdout).includes('Wizard button:') &&
    exeExists === false;
}

module.exports = { mayRetryOldInstaller };
