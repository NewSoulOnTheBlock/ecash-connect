/** A dapp using only the public ecash-connect API. */
import Wallet, { AddressPurpose, MessageSigningProtocols, verifyMessage, ECASH_NETWORKS, type RequestReturn, type Method } from 'ecash-connect';

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;
const log = $<HTMLPreElement>('log');
let address: string | undefined;
let network: keyof typeof ECASH_NETWORKS = 'Regtest' as keyof typeof ECASH_NETWORKS;

function write(label: string, res: RequestReturn<Method> | unknown) {
  const line = `${new Date().toLocaleTimeString()}  ${label}\n${JSON.stringify(res, null, 2)}\n\n`;
  log.textContent = line + (log.textContent?.startsWith('Waiting') ? '' : log.textContent);
}

function connected(on: boolean) {
  for (const id of ['balance', 'disconnect', 'sign', 'send', 'deposit']) $<HTMLButtonElement>(id).disabled = !on;
}

$('connect').onclick = async () => {
  const res = await Wallet.request('wallet_connect', { message: 'Try the eCash Connect demo' });
  write('wallet_connect', res);
  if (res.status !== 'success') return;
  address = res.result.addresses.find((a) => a.purpose === AddressPurpose.Payment)?.address;
  network = res.result.network.ecash.name;
  $('who').textContent = `${address} on ${network}`;
  $('who').className = 'status ok';
  connected(true);
  const sc = await Wallet.request('drivechain_getSidechains', undefined);
  write('drivechain_getSidechains', sc);
  if (sc.status === 'success') {
    $<HTMLSelectElement>('slot').replaceChildren(
      ...sc.result.map((c) => Object.assign(document.createElement('option'), { value: String(c.slot), textContent: `${c.title} (slot ${c.slot})` }))
    );
  }
};

$('balance').onclick = async () => write('getBalance', await Wallet.request('getBalance', undefined));

$('disconnect').onclick = async () => {
  await Wallet.disconnect();
  address = undefined;
  $('who').textContent = 'Not connected.';
  $('who').className = 'status';
  connected(false);
  write('disconnect', { ok: true });
};

$('sign').onclick = async () => {
  const message = $('message').value;
  const protocol = $<HTMLSelectElement>('protocol').value as MessageSigningProtocols;
  const res = await Wallet.request('signMessage', { address: address!, message, protocol });
  write('signMessage', res);
  if (res.status === 'success') {
    // Anyone can check it, e.g. a server logging the user in.
    const ok = verifyMessage({ address: address!, message, signature: res.result.signature, network: ECASH_NETWORKS[network].address });
    write('verifyMessage (in the dapp)', { valid: ok });
  }
};

$('send').onclick = async () => {
  const res = await Wallet.request('sendTransfer', { recipients: [{ address: $('to').value.trim(), amount: Number($('amount').value) }] });
  write('sendTransfer', res);
};

$('deposit').onclick = async () => {
  const res = await Wallet.request('drivechain_deposit', {
    slot: Number($<HTMLSelectElement>('slot').value),
    sidechainAddress: $('scaddr').value.trim(),
    amount: Number($('depamount').value),
  });
  write('drivechain_deposit', res);
};

// Wallet events: the user switched network or disconnected this site in the wallet.
window.addEventListener('load', () => {
  const off = [
    Wallet.addListener({ eventName: 'networkChange', cb: (e) => write('event: networkChange', e) }),
    Wallet.addListener({ eventName: 'disconnect', cb: (e) => (write('event: disconnect', e), connected(false)) }),
  ];
  window.addEventListener('beforeunload', () => off.forEach((f) => f()));
});
