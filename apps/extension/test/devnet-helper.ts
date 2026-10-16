/**
 * Runs test/devnet.sh, which funds addresses and mines blocks on a local eCash
 * devnet (ECX regtest + bip300301_enforcer). On Windows the devnet lives in
 * WSL, so the script runs there; set WSL_DISTRO if yours is not "Debian".
 */
import { join } from 'node:path';

const script = join(import.meta.dir, 'devnet.sh');

/** C:\a\b -> /mnt/c/a/b */
function toWsl(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return m ? `/mnt/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, '/')}` : p.replace(/\\/g, '/');
}

export function devnet(...args: string[]): string {
  const cmd =
    process.platform === 'win32'
      ? ['wsl', '-d', process.env.WSL_DISTRO ?? 'Debian', '--', 'bash', toWsl(script), ...args]
      : ['bash', script, ...args];
  const r = Bun.spawnSync(cmd, { env: process.env });
  if (r.exitCode !== 0) throw new Error(`devnet ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
