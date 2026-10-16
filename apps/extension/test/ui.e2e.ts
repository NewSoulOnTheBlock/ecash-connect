/**
 * The real extension in a real Chromium, driven like a user, against the
 * eCash Cat devnet:
 *
 *   bun run --cwd apps/extension build && bun run --cwd apps/demo build
 *   CHROMIUM=<path to chrome.exe> bun apps/extension/test/ui.e2e.ts
 *
 * Branded Chrome ignores --load-extension since v137, so this needs a
 * Chromium build (Playwright's cached one works). Screenshots land in
 * $SHOTS (default: ./shots).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { base58 } from '@scure/base';
import { formatDepositAddress, getCtip } from '@ecash-connect/core';

const ROOT = resolve(import.meta.dir, '..', '..', '..');
const EXT = join(ROOT, 'apps', 'extension', 'dist');
const DEMO = join(ROOT, 'apps', 'demo', 'dist');
const SHOTS = process.env.SHOTS ?? join(import.meta.dir, 'shots');
const CHROMIUM = process.env.CHROMIUM ?? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const SLOT = Number(process.env.SLOT ?? 77);
const PASSWORD = 'meow meow meow';

mkdirSync(SHOTS, { recursive: true });

function devnet(...args: string[]): string {
  const r = Bun.spawnSync(['wsl', '-d', 'Debian', '--', 'bash', '/mnt/c/Users/roota/dev/ecash-connect/apps/extension/test/devnet.sh', ...args]);
  if (r.exitCode !== 0) throw new Error(`devnet ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

let n = 0;
function ok(msg: string) {
  console.log(`  ok ${++n} ${msg}`);
}
const shot = (p: Page, name: string) => p.screenshot({ path: join(SHOTS, `${String(n).padStart(2, '0')}-${name}.png`) });

const server = Bun.serve({
  port: 5174,
  fetch(req) {
    const path = new URL(req.url).pathname;
    return new Response(Bun.file(join(DEMO, path === '/' ? 'index.html' : path)));
  },
});

const profile = mkdtempSync(join(tmpdir(), 'ecash-cat-ui-'));
let ctx: BrowserContext | undefined;
let chrome: ReturnType<typeof Bun.spawn> | undefined;
try {
  // Launched by hand and attached over CDP: Playwright's default pipe
  // transport needs extra stdio handles that Bun does not pass on Windows.
  const port = 9333;
  chrome = Bun.spawn(
    [
      CHROMIUM,
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--window-size=1100,900',
      'about:blank',
    ],
    { stdout: 'ignore', stderr: 'ignore' }
  );
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      await Bun.sleep(500);
    }
  }
  if (!browser) throw new Error('Chromium did not open its debugging port');
  ctx = browser.contexts()[0]!;
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  ok(`extension loaded (${extId})`);

  // The popup page is the toolbar popup; open it as a tab to drive it.
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 360, height: 640 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.getByRole('button', { name: 'Create a new wallet' }).click();
  await popup.getByText('I wrote these 12 words down').click();
  await popup.getByPlaceholder('At least 8 characters').fill(PASSWORD);
  await popup.getByPlaceholder('Type it again').fill(PASSWORD);
  await popup.getByRole('button', { name: 'Create wallet' }).click();
  const address = (await popup.locator('.addr').first().textContent())!.trim();
  if (!address.startsWith('bcrt1q')) throw new Error(`unexpected address ${address}`);
  ok(`created a wallet in the popup: ${address}`);

  devnet('fund', address, '200000000');
  devnet('mine', '1');
  await popup.reload();
  await popup.getByText('2 ECX').first().waitFor({ timeout: 30_000 }).catch(async () => {
    await Bun.sleep(3000);
    await popup.reload();
    await popup.getByText(/^2\s*ECX/).first().waitFor({ timeout: 30_000 });
  });
  await shot(popup, 'popup-home');
  ok('popup shows the 2 ECX balance after funding');

  const dapp = await ctx.newPage();
  await dapp.goto(`http://localhost:${server.port}/`);
  ok('demo dapp loaded');

  // Approvals open in their own window: wait for it, click, return.
  async function approve(trigger: () => Promise<void>, button: string, name: string) {
    const [win] = await Promise.all([ctx!.waitForEvent('page'), trigger()]);
    await win.waitForLoadState();
    await win.getByRole('button', { name: button }).waitFor();
    await shot(win, name);
    await win.getByRole('button', { name: button }).click();
  }

  // 1. connect: the forked sats-connect-ui selector, then the wallet's prompt
  await dapp.getByRole('button', { name: 'Connect wallet' }).click();
  await dapp.getByText('eCash Cat Wallet').first().waitFor();
  await shot(dapp, 'selector');
  ok('the wallet selector (forked sats-connect-ui) lists eCash Cat Wallet');
  await approve(() => dapp.getByText('eCash Cat Wallet').first().click(), 'Connect', 'approve-connect');
  await dapp.locator('#who.ok').waitFor();
  const who = await dapp.locator('#who').textContent();
  if (!who?.includes(address)) throw new Error(`dapp shows ${who}`);
  ok('connected: the dapp shows the wallet address');

  // 2. sign a message, verified in the dapp
  await approve(() => dapp.getByRole('button', { name: 'Sign' }).click(), 'Sign', 'approve-sign');
  await dapp.getByText('"valid": true').waitFor();
  ok('signed a BIP322 message; the dapp verified it');

  // 3. send
  const friend = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';
  await dapp.locator('#to').fill(friend);
  await approve(() => dapp.getByRole('button', { name: 'Send' }).click(), 'Approve', 'approve-send');
  await dapp.getByText('sendTransfer').first().waitFor();
  const sendLog = await dapp.locator('#log').textContent();
  const sendTxid = /"txid": "([0-9a-f]{64})"/.exec(sendLog ?? '')?.[1];
  if (!sendTxid) throw new Error(`no txid in log: ${sendLog?.slice(0, 400)}`);
  ok(`sent 100,000 sats (${sendTxid.slice(0, 12)}…)`);

  // 4. deposit to the sidechain
  const before = await getCtip('http://127.0.0.1:50051', SLOT);
  const scAddr = formatDepositAddress(base58.encode(crypto.getRandomValues(new Uint8Array(20))), SLOT);
  await dapp.locator('#slot').selectOption(String(SLOT));
  await dapp.locator('#scaddr').fill(scAddr);
  await approve(() => dapp.getByRole('button', { name: 'Deposit' }).click(), 'Approve', 'approve-deposit');
  await dapp.getByText('drivechain_deposit').first().waitFor();
  const depLog = await dapp.locator('#log').textContent();
  const depTxid = /"txid": "([0-9a-f]{64})"/.exec(depLog ?? '')?.[1];
  if (!depTxid) throw new Error(`no deposit txid: ${depLog?.slice(0, 400)}`);
  devnet('mine', '1');
  let after = await getCtip('http://127.0.0.1:50051', SLOT);
  for (let i = 0; i < 20 && after?.txid !== depTxid; i++) {
    await Bun.sleep(1000);
    after = await getCtip('http://127.0.0.1:50051', SLOT);
  }
  if (after?.txid !== depTxid || after.value !== (before?.value ?? 0n) + 1_000_000n) throw new Error('enforcer did not take the deposit');
  ok(`deposited 0.01 ECX into slot ${SLOT}; the enforcer took it as the new treasury (${after.value} sats)`);
  await shot(dapp, 'dapp-after');

  // 5. disconnecting in the wallet reaches the dapp as an event
  await popup.reload();
  await popup.getByRole('button', { name: 'Disconnect' }).click();
  await dapp.getByText('event: disconnect').waitFor({ timeout: 10_000 });
  ok('disconnecting in the wallet fired a disconnect event in the dapp');

  console.log(`\nall ${n} UI checks passed; screenshots in ${SHOTS}`);
} finally {
  await ctx?.browser()?.close().catch(() => {});
  chrome?.kill();
  await chrome?.exited;
  server.stop();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Chromium can hold the profile briefly on Windows; it is in the temp dir.
  }
}
