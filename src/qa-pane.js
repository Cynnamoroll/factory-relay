import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// No arbitrary URL, window title, profile, or run-supplied browser setting reaches the launcher.
// qa-open validates the Factory endpoint independently before its first browser command.
export function autoOpenWindowPane(credentials, { env = process.env, launch = spawn } = {}) {
  let attempted = false;
  return target => {
    if (attempted || !target?.windowId || target.kind === 'desktop' ||
        !env.FACTORY_DESKTOP_CDP_PORT || !env.AGENT_BROWSER_CDP) return;
    attempted = true;
    const child = launch(process.execPath, [fileURLToPath(new URL('../scripts/qa-open.js', import.meta.url)), credentials],
      { env, stdio: 'ignore' });
    const failed = () => console.error('Factory pane did not pair. From the same Factory project, run npm run qa:open.');
    child.once('error', failed);
    child.once('exit', code => { if (code !== 0) failed(); });
    child.unref();
  };
}
