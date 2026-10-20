// emunet test suite. Never touches real system settings:
// isolated config dir, EMUNET_DRY_RUN, fake DNS servers on high ports, a fake network service
// and a fake `networksetup` for the watchdog.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

// Async on purpose: the fake DNS servers live in this process and must keep answering.
const run = (cmd, args, opts = {}) => promisify(execFile)(cmd, args, { encoding: 'utf8', timeout: 30000, ...opts })
  .then((r) => ({ status: 0, ...r }), (e) => ({ status: e.code ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' }));
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'emunet.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'emunet-test-'));
const BASE = 25300 + Math.floor(Math.random() * 500);
const PORTS = { vpn: BASE + 1, isp: BASE + 2, pub: BASE + 3, corp: BASE + 4, dead: BASE + 5, emunetDns: BASE + 6, emunetProxy: BASE + 7, hijack: BASE + 8, health: BASE + 9, tcpClose: BASE + 10 };

fs.writeFileSync(path.join(TMP, 'state.json'), JSON.stringify({ proxyPort: PORTS.emunetProxy, dnsPort: PORTS.emunetDns, upstream: 'none', manageEmulators: false }));
Object.assign(process.env, {
  EMUNET_CONFIG_DIR: TMP,
  EMUNET_DRY_RUN: '1',
  EMUNET_FAKE_AGENTS: '',
  EMUNET_NO_EMULATORS: '1',
  EMUNET_FAKE_SERVICE: JSON.stringify({ name: 'Wi-Fi', dnsServers: ['192.168.1.1'] }),
});
const emunet = await import(CLI);

// ---------------------------------------------------------------------------
// Fake DNS servers
// ---------------------------------------------------------------------------

const hits = { vpn: [], isp: [], pub: [], corp: [], hijack: [], health: [] };

function reply(query, rcode, address) {
  const name = emunet.queryName(query);
  const qlen = name.length + 2 + 4;
  const header = Buffer.from(query.subarray(0, 12));
  header[2] = 0x80 | (query[2] & 0x01);
  header[3] = 0x80 | rcode;
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(address ? 1 : 0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  const parts = [header, query.subarray(12, 12 + qlen)];
  if (address) {
    const answer = Buffer.alloc(16);
    answer.writeUInt16BE(0xc00c, 0);
    answer.writeUInt16BE(1, 2);
    answer.writeUInt16BE(1, 4);
    answer.writeUInt32BE(60, 6);
    answer.writeUInt16BE(4, 10);
    address.split('.').forEach((o, i) => (answer[12 + i] = Number(o)));
    parts.push(answer);
  }
  return Buffer.concat(parts);
}

// behaviour(name) -> { rcode, address } | 'drop' | 'badid'
function fakeDns(key, port, behaviour) {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (msg, rinfo) => {
    const name = emunet.queryName(msg);
    hits[key]?.push(name);
    const b = behaviour(name);
    if (b === 'drop') return;
    let out = reply(msg, b.rcode, b.address);
    if (b === 'badid' || b.badid) out.writeUInt16BE((msg.readUInt16BE(0) + 1) & 0xffff, 0);
    socket.send(out, rinfo.port, rinfo.address);
  });
  return new Promise((resolve) => socket.bind(port, '127.0.0.1', () => resolve(socket)));
}

let vpnMode = 'refused';
const servers = [];
before(async () => {
  servers.push(await fakeDns('vpn', PORTS.vpn, (name) => {
    if (name.endsWith('corp.example')) return name.startsWith('nope') ? { rcode: 3 } : { rcode: 0, address: '10.0.0.5' };
    if (vpnMode === 'refused') return { rcode: 5 };
    if (vpnMode === 'nxdomain') return { rcode: 3 };
    if (vpnMode === 'servfail') return { rcode: 2 };
    if (vpnMode === 'drop') return 'drop';
    if (vpnMode === 'badid') return { rcode: 0, address: '6.6.6.6', badid: true };
    return { rcode: 0, address: '10.9.9.9' };
  }));
  servers.push(await fakeDns('isp', PORTS.isp, (name) => (name.endsWith('corp.example') ? { rcode: 3 } : { rcode: 0, address: '93.184.216.34' })));
  servers.push(await fakeDns('pub', PORTS.pub, () => ({ rcode: 0, address: '1.1.1.1' })));
  // A home router that answers every unknown name with its own address (NXDOMAIN hijacking).
  servers.push(await fakeDns('hijack', PORTS.hijack, () => ({ rcode: 0, address: '192.168.1.1' })));
  // Stands in for a live emunet: answers the health name the watchdog asks for.
  servers.push(await fakeDns('health', PORTS.health, (name) => (name === 'emunet-health.invalid' ? { rcode: 0, address: '127.0.0.77' } : { rcode: 2 })));
  servers.push(await fakeDns('corp', PORTS.corp, (name) => (name.startsWith('nope') ? { rcode: 3 } : { rcode: 0, address: '10.1.1.1' })));
});
after(() => {
  servers.forEach((s) => s.close());
  fs.rmSync(TMP, { recursive: true, force: true });
});

const srv = (k) => `127.0.0.1:${PORTS[k]}`;
function model(extra = {}) {
  emunet.setDnsModelForTest({ defaults: [srv('vpn')], dhcp: [srv('isp')], vpn: [srv('vpn')], public: [srv('pub')], ...extra });
}
async function ask(name) {
  const q = emunet.buildQuery(name);
  const r = await emunet.resolveRaw(q, 'udp', { timeoutMs: 600 });
  return { rcode: r[3] & 0x0f, addrs: emunet.parseARecords(r) };
}
function resetHits() {
  Object.values(hits).forEach((list) => list.splice(0));
}

// ---------------------------------------------------------------------------
// 1. DNS fall-through (fix 1): never break public names behind a split-horizon VPN DNS
// ---------------------------------------------------------------------------

for (const [mode, label] of [['refused', 'REFUSED'], ['nxdomain', 'NXDOMAIN'], ['servfail', 'SERVFAIL'], ['drop', 'timeout'], ['badid', 'mismatched id']]) {
  test(`VPN DNS answering ${label} for a public name → falls through to the network DNS`, async () => {
    vpnMode = mode;
    model();
    resetHits();
    const r = await ask('www.example.org');
    assert.equal(r.rcode, 0);
    assert.deepEqual(r.addrs, ['93.184.216.34']);
    assert.equal(hits.pub.length, 0, 'public resolvers must not be needed');
  });
}

test('VPN DNS that answers public names is used as is (VPN-first, like the VPN intends)', async () => {
  vpnMode = 'answer';
  model();
  resetHits();
  assert.deepEqual((await ask('www.example.org')).addrs, ['10.9.9.9']);
  assert.equal(hits.isp.length, 0);
});

test('internal names keep resolving through the VPN DNS', async () => {
  vpnMode = 'refused';
  model();
  assert.deepEqual((await ask('jira.corp.example')).addrs, ['10.0.0.5']);
});

test('a name that exists nowhere returns NXDOMAIN and is NOT sent to public resolvers (no leak)', async () => {
  vpnMode = 'nxdomain';
  model();
  resetHits();
  const r = await ask('nope.corp.example');
  assert.equal(r.rcode, 3);
  assert.equal(hits.pub.length, 0);
});

test('when the VPN and network DNS are both down, public resolvers are the last resort', async () => {
  model({ defaults: [`127.0.0.1:${PORTS.dead}`], dhcp: [`127.0.0.1:${PORTS.dead}`], vpn: [] });
  resetHits();
  assert.deepEqual((await ask('www.example.org')).addrs, ['1.1.1.1']);
});

test('when nothing answers, resolveRaw throws (forwarder replies SERVFAIL)', async () => {
  emunet.setDnsModelForTest({ defaults: [], dhcp: [], public: [`127.0.0.1:${PORTS.dead}`] });
  await assert.rejects(() => emunet.resolveRaw(emunet.buildQuery('x.example'), 'udp', { timeoutMs: 300 }));
});

test("the VPN's NXDOMAIN for its own domain is final (a hijacking router must not win)", async () => {
  vpnMode = 'refused';
  model({ dhcp: [srv('hijack')], vpnDomains: ['corp.example'] });
  resetHits();
  const r = await ask('nope.corp.example');
  assert.equal(r.rcode, 3);
  assert.equal(hits.hijack.length, 0);
});

test('outside the VPN domains a VPN NXDOMAIN still falls through (split-horizon VPN DNS)', async () => {
  vpnMode = 'nxdomain';
  model({ vpnDomains: ['corp.example'] });
  assert.deepEqual((await ask('www.example.org')).addrs, ['93.184.216.34']);
});

// ---------------------------------------------------------------------------
// 2. Split DNS (fix 2): per-domain resolvers only get their domains
// ---------------------------------------------------------------------------

test('supplemental (match-domain) resolver gets only its domain, longest match wins', async () => {
  vpnMode = 'answer';
  model({ supplemental: [{ domain: 'corp.example', servers: [srv('corp')] }, { domain: 'example', servers: [srv('isp')] }] });
  resetHits();
  assert.deepEqual((await ask('wiki.corp.example')).addrs, ['10.1.1.1']);
  assert.equal(hits.vpn.length, 0);
  const order = emunet.serversFor('www.google.com').map((s) => s.server);
  assert.ok(!order.includes(srv('corp')), 'public names must not go to the match-domain resolver');
});

test('NXDOMAIN from the resolver that owns the domain is final', async () => {
  model({ supplemental: [{ domain: 'corp.example', servers: [srv('corp')] }] });
  resetHits();
  assert.equal((await ask('nope.corp.example')).rcode, 3);
  assert.equal(hits.vpn.length + hits.isp.length + hits.pub.length, 0);
});

test('parseScutilDns reads default, supplemental, mdns and port, and ignores the scoped section', () => {
  const text = `DNS configuration

resolver #1
  search domain[0] : corp.example
  nameserver[0] : 10.20.0.53
  nameserver[1] : fe80::1
  flags    : Request A records

resolver #2
  domain   : tail.example.ts.net.
  nameserver[0] : 100.100.100.100
  port     : 5353

resolver #3
  domain   : local
  options  : mdns

DNS configuration (for scoped queries)

resolver #1
  nameserver[0] : 192.168.1.1
  if_index : 14 (en0)
`;
  const r = emunet.parseScutilDns(text);
  assert.equal(r.length, 3);
  assert.deepEqual(r[0], { domain: null, servers: ['10.20.0.53'], mdns: false, ifName: null });
  assert.deepEqual(r[1].servers, ['100.100.100.100:5353']);
  assert.equal(r[1].domain, 'tail.example.ts.net');
  assert.equal(r[2].mdns, true);
});

// ---------------------------------------------------------------------------
// 3. Company policy
// ---------------------------------------------------------------------------

test('security agents are recognised, ordinary tools are not', () => {
  assert.deepEqual(emunet.detectAgents('/Applications/Zscaler/Zscaler.app/Contents/PlugIns/ZscalerTunnel'), ['Zscaler']);
  assert.deepEqual(emunet.detectAgents('com.netskope.client.Netskope-Client.NetskopeClientMacAppProxy'), ['Netskope']);
  assert.deepEqual(emunet.detectAgents('/Applications/Cloudflare WARP.app/Contents/Resources/CloudflareWARP'), ['Cloudflare WARP / Zero Trust']);
  assert.deepEqual(emunet.detectAgents('/opt/cisco/secureclient/bin/acumbrellaagent'), ['Cisco Umbrella / Secure Client']);
  assert.deepEqual(emunet.detectAgents('/Applications/Proxyman.app\n/Applications/Charles.app\nOpenVPN Connect\nTunnelblick\nnode'), []);
});

function cli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000 });
}

test('mac-dns on stops with a policy message when a security agent is present (and changes nothing)', () => {
  const r = cli(['mac-dns', 'on'], { EMUNET_FAKE_AGENTS: '/Applications/Zscaler/ZscalerTunnel' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Your organization manages this Mac's network security with Zscaler/);
  assert.doesNotMatch(r.stdout + r.stderr, /dry-run\] networksetup/);
});

test('with a security agent, emulator DNS is answered by the system resolver (company DNS policy applies)', async () => {
  emunet.setManagedForTest(['Zscaler']);
  try {
    emunet.setDnsModelForTest({ defaults: [`127.0.0.1:${PORTS.dead}`], dhcp: [], public: [`127.0.0.1:${PORTS.dead}`] });
    const r = await emunet.answerQuery(emunet.buildQuery('localhost'), 'udp');
    assert.equal(r[3] & 0x0f, 0);
    assert.deepEqual(emunet.parseARecords(r), ['127.0.0.1']);
  } finally {
    emunet.setManagedForTest([]);
  }
});

// ---------------------------------------------------------------------------
// 4. mac-dns safety: refuse without a working forwarder, remember + restore, watchdog
// ---------------------------------------------------------------------------

test('mac-dns on is refused when emunet is not answering DNS', () => {
  const r = cli(['mac-dns', 'on']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not answering DNS/);
  assert.doesNotMatch(r.stdout, /networksetup -setdnsservers/);
});

function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  return Promise.resolve(fn()).then((v) => ({ v, lines }), (e) => ({ e, lines })).finally(() => (console.log = orig));
}
const readState = () => JSON.parse(fs.readFileSync(path.join(TMP, 'state.json'), 'utf8'));
const fakeService = (name, dnsServers, others) => (process.env.EMUNET_FAKE_SERVICE = JSON.stringify({ name, dnsServers, others }));

test('mac-dns on remembers the previous DNS (IPv4 + IPv6) per service, installs the watchdog; off restores exactly it', async () => {
  const guard = path.join(TMP, 'local.emunet.dnsguard.plist');
  fakeService('Wi-Fi', ['192.168.1.1', '2606:4700::1111']);
  assert.equal(await emunet.setMacDns(true), true);
  assert.deepEqual(readState().macDns, { 'Wi-Fi': ['192.168.1.1', '2606:4700::1111'] });
  assert.ok(fs.existsSync(guard));
  assert.match(fs.readFileSync(guard, 'utf8'), /StartInterval/);

  fakeService('Wi-Fi', ['127.0.0.1']);
  assert.equal(await emunet.setMacDns(true), true, 'calling on twice keeps the original previous value');
  assert.deepEqual(readState().macDns['Wi-Fi'], ['192.168.1.1', '2606:4700::1111']);

  const { v, lines } = await captureLog(() => emunet.setMacDns(false));
  assert.equal(v, true);
  assert.ok(lines.some((l) => l.includes('networksetup -setdnsservers Wi-Fi 192.168.1.1 2606:4700::1111')), lines.join('\n'));
  assert.ok(!fs.existsSync(guard));
  assert.deepEqual(readState().macDns, {});
  fakeService('Wi-Fi', ['192.168.1.1']);
});

test('mac-dns off restores the service emunet changed, even after another service became primary', async () => {
  fakeService('Wi-Fi', []);
  await emunet.setMacDns(true);
  // Ethernet is primary now; Wi-Fi still points at emunet.
  fakeService('Ethernet', ['9.9.9.9'], { 'Wi-Fi': ['127.0.0.1'] });
  const { lines } = await captureLog(() => emunet.setMacDns(false));
  assert.ok(lines.some((l) => l.includes('-setdnsservers Wi-Fi Empty')), lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes('Ethernet')), 'never touches a service emunet did not change');
  fakeService('Wi-Fi', ['192.168.1.1']);
});

test('mac-dns off leaves a service alone if the user changed it since', async () => {
  fakeService('Wi-Fi', ['192.168.1.1']);
  await emunet.setMacDns(true);
  fakeService('Wi-Fi', ['8.8.4.4']); // user set their own DNS meanwhile
  const { lines } = await captureLog(() => emunet.setMacDns(false));
  assert.ok(!lines.some((l) => l.includes('-setdnsservers')), lines.join('\n'));
  fakeService('Wi-Fi', ['192.168.1.1']);
});

test('parseDnsServersOutput keeps IPv4 and IPv6 and treats the "none" message as automatic', () => {
  assert.deepEqual(emunet.parseDnsServersOutput('1.1.1.1\n2606:4700::1111\nfe80::1%en0\n'), ['1.1.1.1', '2606:4700::1111', 'fe80::1%en0']);
  assert.deepEqual(emunet.parseDnsServersOutput("There aren't any DNS Servers set on Wi-Fi.\n"), []);
});

test('mac-dns on is refused when this account cannot change DNS without sudo (watchdog could not undo it)', async () => {
  const failing = path.join(TMP, 'networksetup-fails.sh');
  fs.writeFileSync(failing, '#!/bin/sh\n[ "$1" = "-getdnsservers" ] && { echo "There aren\'t any DNS Servers set on Wi-Fi."; exit 0; }\necho "requires admin" >&2; exit 14\n');
  fs.chmodSync(failing, 0o755);
  // Real (non-dry) path with a fake networksetup, against a fake live emunet (the health server).
  fs.writeFileSync(path.join(TMP, 'state.json'), JSON.stringify({ ...readState(), dnsPort: PORTS.health }));
  const r = await run(process.execPath, [CLI, 'mac-dns', 'on'], { env: { ...process.env, EMUNET_DRY_RUN: '0', EMUNET_NETWORKSETUP: failing, EMUNET_FAKE_SERVICE: '' } });
  fs.writeFileSync(path.join(TMP, 'state.json'), JSON.stringify({ ...readState(), dnsPort: PORTS.emunetDns }));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /cannot change DNS settings without an administrator password/);
  assert.equal(readState().macDns?.['Wi-Fi'], undefined);
});

async function runGuard({ current, answering, services = { "Wi-Fi 'Home'": ['192.168.1.1', '2606:4700::1111'] } }) {
  const log = path.join(TMP, `guard-${Math.random()}.log`);
  const calls = path.join(TMP, `calls-${Math.random()}.txt`);
  const fake = path.join(TMP, 'fake-networksetup.sh');
  fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >> "${calls}"\n[ "$1" = "-getdnsservers" ] && echo "${current}"\nexit 0\n`);
  fs.chmodSync(fake, 0o755);
  const body = emunet.guardScript({ services, dnsPort: answering, networksetup: fake, script: CLI, log });
  const r = await run('/bin/sh', ['-c', body]);
  return { status: r.status, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '', log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}

test('watchdog restores the previous DNS (IPv4 + IPv6) when emunet does not answer', async () => {
  const r = await runGuard({ current: '127.0.0.1', answering: PORTS.dead });
  assert.match(r.calls, /-setdnsservers Wi-Fi 'Home' 192\.168\.1\.1 2606:4700::1111/);
  assert.match(r.log, /restored/);
});

test('watchdog keeps emunet when it answers the health name (no dependency on real upstream DNS)', async () => {
  const r = await runGuard({ current: '127.0.0.1', answering: PORTS.health });
  assert.doesNotMatch(r.calls, /-setdnsservers/);
});

test('watchdog treats another DNS program on the port as "emunet is gone"', async () => {
  const r = await runGuard({ current: '127.0.0.1', answering: PORTS.isp });
  assert.match(r.calls, /-setdnsservers/);
});

test('watchdog does nothing when the Mac DNS is not pointed at emunet', async () => {
  const r = await runGuard({ current: "There aren't any DNS Servers set on Wi-Fi.", answering: PORTS.dead });
  assert.doesNotMatch(r.calls, /-setdnsservers/);
});

test('watchdog removes its plist before booting itself out when emunet is uninstalled', () => {
  const body = emunet.guardScript({ services: { 'Wi-Fi': ['Empty'] }, dnsPort: 53, script: '/nonexistent/emunet.mjs', log: '/dev/null' });
  const last = body.split('\n').find((l) => l.includes('/nonexistent/emunet.mjs'));
  assert.ok(last.indexOf('rm -f') < last.indexOf('launchctl bootout'), last);
});

// ---------------------------------------------------------------------------
// 5. Proxy settings parsing (PAC / WPAD)
// ---------------------------------------------------------------------------

test('parseProxySettings detects PAC, WPAD and manual proxies', () => {
  const pac = emunet.parseProxySettings('ProxyAutoConfigEnable : 1\n  ProxyAutoConfigURLString : http://wpad.corp/proxy.pac\n  ProxyAutoDiscoveryEnable : 1\n');
  assert.equal(pac.pac, 'http://wpad.corp/proxy.pac');
  assert.equal(pac.autoDiscovery, true);
  assert.equal(pac.proxy, null);
  const manual = emunet.parseProxySettings('HTTPEnable : 1\n  HTTPPort : 8888\n  HTTPProxy : 127.0.0.1\n  HTTPSEnable : 1\n  HTTPSPort : 9090\n  HTTPSProxy : 127.0.0.1\n');
  assert.deepEqual(manual.proxy, { host: '127.0.0.1', port: 9090 });
  assert.equal(manual.pac, null);
});

// ---------------------------------------------------------------------------
// 6. End to end: a real daemon on test ports (no emulator management, no Mac changes)
// ---------------------------------------------------------------------------

test('daemon end to end: health name, UDP + TCP forwarding with fall-through, proxy CONNECT', async () => {
  vpnMode = 'refused';
  const dnsModel = { defaults: [srv('vpn')], dhcp: [srv('isp')], vpn: [srv('vpn')], public: [srv('pub')] };
  const daemon = spawn(process.execPath, [CLI, 'daemon'], { env: { ...process.env, EMUNET_DNS_MODEL: JSON.stringify(dnsModel) }, stdio: 'ignore' });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i += 1) {
      up = await emunet.emunetDnsAnswering(300).catch(() => false);
      if (!up) await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(up, 'health name answered by the daemon');
    const dig = async (extra) => (await run('/usr/bin/dig', ['+time=3', '+tries=1', '+short', '-p', String(PORTS.emunetDns), '@127.0.0.1', ...extra])).stdout.trim();
    assert.equal(await dig(['www.example.org']), '93.184.216.34');
    assert.equal(await dig(['jira.corp.example']), '10.0.0.5');
    // TCP query: fake upstreams speak UDP only, so the forwarder must still reply (SERVFAIL) instead of hanging.
    const tcp = await run('/usr/bin/dig', ['+time=8', '+tries=1', '+tcp', '-p', String(PORTS.emunetDns), '@127.0.0.1', 'jira.corp.example']);
    assert.match(tcp.stdout, /status: (SERVFAIL|NOERROR)/);
    const curl = await run('/usr/bin/curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '-m', '15', '-x', `http://127.0.0.1:${PORTS.emunetProxy}`, 'https://1.1.1.1/']);
    assert.match(curl.stdout, /^(200|301|302|403)$/, `proxy CONNECT works: ${curl.stdout} ${curl.stderr}`);
  } finally {
    daemon.kill();
  }
});

// ---------------------------------------------------------------------------
// 7. Service uninstall and policy-driven fix (dry-run, no real LaunchAgents touched)
// ---------------------------------------------------------------------------

test('service uninstall switches mac-dns off first (restoring the saved DNS) and removes the agent', () => {
  fs.writeFileSync(path.join(TMP, 'local.emunet.plist'), 'x');
  const st = JSON.parse(fs.readFileSync(path.join(TMP, 'state.json'), 'utf8'));
  fs.writeFileSync(path.join(TMP, 'state.json'), JSON.stringify({ ...st, macDns: { 'Wi-Fi': ['10.0.0.1'] } }));
  const r = cli(['service', 'uninstall'], { EMUNET_FAKE_SERVICE: JSON.stringify({ name: 'Wi-Fi', dnsServers: ['127.0.0.1'] }) });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.ok(out.indexOf('setdnsservers Wi-Fi 10.0.0.1') !== -1, out);
  assert.ok(out.indexOf('setdnsservers') < out.indexOf('launchctl bootout'), 'DNS restored before the service goes away');
  assert.ok(!fs.existsSync(path.join(TMP, 'local.emunet.plist')));
});

test('fix under a security agent restores the Mac DNS instead of keeping it on emunet', () => {
  fs.writeFileSync(path.join(TMP, 'state.json'), JSON.stringify({ proxyPort: PORTS.emunetProxy, dnsPort: PORTS.emunetDns, upstream: 'none', manageEmulators: false, macDns: { 'Wi-Fi': ['Empty'] } }));
  const r = cli(['fix'], { EMUNET_FAKE_AGENTS: 'Netskope Client', EMUNET_FAKE_SERVICE: JSON.stringify({ name: 'Wi-Fi', dnsServers: ['127.0.0.1'] }) });
  assert.match(r.stdout, /Managed network security: Netskope/);
  assert.match(r.stdout, /restoring the previous DNS setting to comply with company policy/);
  assert.match(r.stdout, /setdnsservers Wi-Fi Empty/);
  assert.doesNotMatch(r.stdout, /setdnsservers Wi-Fi 127\.0\.0\.1/);
});

test('fix never turns the system proxy off under a security agent', () => {
  // A dead system proxy is simulated by the real check failing only if one is configured; here we
  // just make sure the policy text is wired into the proxy branch.
  const src = fs.readFileSync(CLI, 'utf8');
  const branch = src.slice(src.indexOf('// 4. System proxy'), src.indexOf('// 5. Upstream used'));
  assert.match(branch, /if \(fix && managedNetwork\.detected\) \{\s*console\.log\(`  \$\{policyMessage\(\)\}`\);/);
});

// ---------------------------------------------------------------------------
// 8. Review fixes: TCP upstream that hangs up, short TCP frames, managed + mac-dns loop
// ---------------------------------------------------------------------------

test('TCP query falls through when an upstream accepts and immediately closes', async () => {
  const net = await import('node:net');
  const closer = net.createServer((sock) => sock.end());
  await new Promise((r) => closer.listen(PORTS.tcpClose, '127.0.0.1', r));
  // A TCP-speaking "good" server: reply to length-prefixed queries.
  const good = net.createServer((sock) => {
    sock.on('data', (buf) => {
      const q = buf.subarray(2, 2 + buf.readUInt16BE(0));
      const out = reply(q, 0, '4.4.4.4');
      const len = Buffer.alloc(2);
      len.writeUInt16BE(out.length);
      sock.end(Buffer.concat([len, out]));
    });
  });
  await new Promise((r) => good.listen(PORTS.tcpClose + 20, '127.0.0.1', r));
  try {
    emunet.setDnsModelForTest({ defaults: [`127.0.0.1:${PORTS.tcpClose}`], dhcp: [`127.0.0.1:${PORTS.tcpClose + 20}`], public: [] });
    const started = Date.now();
    const r = await emunet.resolveRaw(emunet.buildQuery('www.example.org'), 'tcp', { timeoutMs: 3000 });
    assert.deepEqual(emunet.parseARecords(r), ['4.4.4.4']);
    assert.ok(Date.now() - started < 2000, 'did not wait for the timeout');
  } finally {
    closer.close();
    good.close();
  }
});

test('with a security agent but the Mac DNS on emunet, the forwarder does not loop through the system resolver', async () => {
  const src = fs.readFileSync(CLI, 'utf8');
  assert.match(src, /if \(managedNetwork\.detected && !macDnsPointsAtUs\) return resolveViaSystem\(query\);/);
  assert.match(src, /if \(managedNetwork\.detected && !macDnsPointsAtUs\) return dns\.lookup\(hostname, opts, cb\);/);
});

test('daemon answers a short TCP frame without crashing and keeps serving', async () => {
  const daemon = spawn(process.execPath, [CLI, 'daemon'], { env: { ...process.env, EMUNET_DNS_MODEL: JSON.stringify({ defaults: [srv('isp')], public: [] }) }, stdio: 'ignore' });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i += 1) {
      up = await emunet.emunetDnsAnswering(300);
      if (!up) await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(up);
    const net = await import('node:net');
    await new Promise((resolve) => {
      const sock = net.connect(PORTS.emunetDns, '127.0.0.1', () => sock.write(Buffer.from([0, 3, 1, 2, 3])));
      sock.setTimeout(1000, () => { sock.destroy(); resolve(); });
      sock.on('close', resolve);
      sock.on('error', resolve);
    });
    assert.ok(await emunet.emunetDnsAnswering(1000), 'still answering after a junk frame');
  } finally {
    daemon.kill();
  }
});

test('daemon keeps the proxy running when its DNS port is taken (and does not crash-loop)', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'busy-'));
  const port = PORTS.tcpClose + 40;
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ proxyPort: port + 1, dnsPort: port, upstream: 'none', manageEmulators: false }));
  const blocker = dgram.createSocket('udp4');
  await new Promise((r, j) => { blocker.once('error', j); blocker.bind(port, '0.0.0.0', r); });
  const daemon = spawn(process.execPath, [CLI, 'daemon'], { env: { ...process.env, EMUNET_CONFIG_DIR: dir }, stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(daemon.exitCode, null, 'daemon is still running');
    const net = await import('node:net');
    const proxyUp = await new Promise((resolve) => {
      const sock = net.connect(port + 1, '127.0.0.1', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => resolve(false));
    });
    assert.ok(proxyUp, 'proxy port is serving');
  } finally {
    daemon.kill();
    blocker.close();
  }
});

test('daemon exits when its proxy port is taken (launchd retries)', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'busyproxy-'));
  const port = PORTS.tcpClose + 50;
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ proxyPort: port, dnsPort: port + 1, upstream: 'none', manageEmulators: false }));
  const net = await import('node:net');
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(port, '127.0.0.1', r));
  try {
    const r = await run(process.execPath, [CLI, 'daemon'], { timeout: 8000, env: { ...process.env, EMUNET_CONFIG_DIR: dir } });
    assert.notEqual(r.status, 0);
  } finally {
    blocker.close();
  }
});

test('mac-dns off restores an untracked 127.0.0.1 when nothing answers there (dead DNS), and works without a primary service', async () => {
  fs.writeFileSync(path.join(TMP, 'state.json'), JSON.stringify({ proxyPort: PORTS.emunetProxy, dnsPort: PORTS.dead, upstream: 'none', manageEmulators: false, macDns: {} }));
  const mod = await import(`${CLI}?untracked`);
  fakeService('Wi-Fi', ['127.0.0.1']);
  const { lines } = await captureLog(() => mod.setMacDns(false));
  assert.ok(lines.some((l) => l.includes('-setdnsservers Wi-Fi Empty')), lines.join('\n'));
  process.env.EMUNET_FAKE_SERVICE = 'null';
  const { v, e } = await captureLog(() => mod.setMacDns(false));
  assert.equal(e, undefined, String(e));
  assert.equal(v, true);
  fakeService('Wi-Fi', ['192.168.1.1']);
});

test('mac-dns off leaves an untracked 127.0.0.1 alone when another DNS program answers there', async () => {
  fs.writeFileSync(path.join(TMP, 'state.json'), JSON.stringify({ proxyPort: PORTS.emunetProxy, dnsPort: PORTS.isp, upstream: 'none', manageEmulators: false, macDns: {} }));
  const mod = await import(`${CLI}?otherdns`);
  fakeService('Wi-Fi', ['127.0.0.1']);
  const { lines } = await captureLog(() => mod.setMacDns(false));
  assert.ok(!lines.some((l) => l.includes('-setdnsservers')), lines.join('\n'));
  fakeService('Wi-Fi', ['192.168.1.1']);
});
