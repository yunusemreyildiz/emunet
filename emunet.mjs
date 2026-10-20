#!/usr/bin/env node
// emunet — keeps Android emulator (and macOS) internet working while VPNs connect/disconnect,
// debugging proxies (Proxyman, Charles, mitmproxy, Burp, Fiddler, HTTP Toolkit, …) start/stop,
// and the Mac moves between networks.
//
//  1. A fixed HTTP/CONNECT proxy on 127.0.0.1:8877. Emulators always point at it (10.0.2.2:8877).
//     If a debugging proxy is running, traffic is chained through it; otherwise it goes direct.
//  2. A DNS forwarder on :53 (loopback clients only). It relays raw queries to the right server:
//     the VPN's DNS through the tunnel when a VPN is up, then the network's DHCP DNS, then
//     1.1.1.1 / 8.8.8.8. It never asks the macOS resolver, so the Mac itself can use it too.
//  3. A supervisor that keeps each emulator's proxy setting and re-triggers Android's network
//     validation when it gets stuck after a network change.
//  4. `emunet doctor` / `emunet fix`: detect and repair common breakages on the Mac and emulators.
import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const VERSION = '0.5.0';

// getaddrinfo runs on libuv's thread pool; a hung VPN resolver must not starve the proxy.
process.env.UV_THREADPOOL_SIZE ||= '16';

// EMUNET_CONFIG_DIR / EMUNET_DRY_RUN / EMUNET_DNS_MODEL / EMUNET_FAKE_AGENTS exist for the test suite.
const CONFIG_DIR = process.env.EMUNET_CONFIG_DIR || path.join(os.homedir(), '.config', 'emunet');
const DRY_RUN = process.env.EMUNET_DRY_RUN === '1';

const SERVICE_LABEL = 'local.emunet';
const SERVICE_PLIST = DRY_RUN
  ? path.join(process.env.EMUNET_CONFIG_DIR || os.tmpdir(), `${SERVICE_LABEL}.plist`)
  : path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
const SERVICE_LOG = path.join(os.homedir(), 'Library', 'Logs', 'emunet.log');
const GUARD_LABEL = 'local.emunet.dnsguard';
const GUARD_PLIST = DRY_RUN
  ? path.join(process.env.EMUNET_CONFIG_DIR || os.tmpdir(), `${GUARD_LABEL}.plist`)
  : path.join(os.homedir(), 'Library', 'LaunchAgents', `${GUARD_LABEL}.plist`);
const HEALTH_NAME = 'emunet-health.invalid';
const NETWORKSETUP = process.env.EMUNET_NETWORKSETUP || '/usr/sbin/networksetup';
const HEALTH_ADDRESS = '127.0.0.77';

const STATE_FILE = path.join(CONFIG_DIR, 'state.json');
const DEFAULTS = {
  proxyPort: 8877,
  dnsPort: 53,
  upstream: 'auto', // auto | none | host:port
  manageEmulators: true,
};

// Debugging proxies emunet can chain through. `ports` are their usual proxy ports; any other
// port a matching process listens on is accepted only if it behaves like an HTTP proxy.
const KNOWN_PROXY_TOOLS = [
  { name: 'Proxyman', match: /proxyman/i, ports: [9090] },
  { name: 'Charles', match: /charles/i, ports: [8888] },
  { name: 'mitmproxy', match: /mitm(proxy|dump|web)/i, ports: [8080] },
  { name: 'Burp Suite', match: /burp/i, ports: [8080] },
  { name: 'Fiddler Everywhere', match: /fiddler/i, ports: [8866] },
  { name: 'HTTP Toolkit', match: /http.?toolkit/i, ports: [8000, 8001, 8002, 8003] },
  { name: 'Requestly', match: /requestly/i, ports: [8281] },
  { name: 'Whistle', match: /whistle/i, ports: [8899] },
];

function loadState() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    // first run
  }
  // Migrate 0.1–0.3 settings (single fixed upstream + mode).
  if (!saved.upstream) {
    if (saved.mode === 'direct') saved.upstream = 'none';
    else if (saved.mode === 'upstream' && saved.upstreamPort) saved.upstream = `${saved.upstreamHost || '127.0.0.1'}:${saved.upstreamPort}`;
  }
  // 0.5 pre-release: single { service, servers } → per-service map.
  if (saved.macDnsPrevious && !saved.macDns) saved.macDns = { [saved.macDnsPrevious.service]: saved.macDnsPrevious.servers };
  delete saved.macDnsPrevious;
  delete saved.mode;
  delete saved.upstreamHost;
  delete saved.upstreamPort;
  return { ...DEFAULTS, ...saved };
}

function saveState(patch) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const next = { ...loadState(), ...patch };
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function log(...args) {
  console.log(new Date().toLocaleString('sv-SE'), ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findAdb() {
  const candidates = [
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb'),
    process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', 'adb'),
    path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || 'adb';
}

function findEmulator() {
  const candidates = [
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'emulator', 'emulator'),
    process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, 'emulator', 'emulator'),
    path.join(os.homedir(), 'Library', 'Android', 'sdk', 'emulator', 'emulator'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || 'emulator';
}

const ADB = findAdb();
let state = loadState();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function sh(cmd, args, timeout = 5000) {
  const { stdout } = await execFileAsync(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

function scutilRun(input) {
  return new Promise((resolve) => {
    const child = execFile('/usr/sbin/scutil', { timeout: 5000 }, (_error, out) => resolve(out || ''));
    child.stdin.end(input);
  });
}

function scutilShow(key) {
  return scutilRun(`show ${key}\n`);
}

function isLoopback(address) {
  return address === '::1' || address === 'localhost' || address.startsWith('127.') || address === '::ffff:127.0.0.1';
}

function ipv4List(text) {
  return [...new Set(text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || [])].filter((ip) => !isLoopback(ip));
}

function probeTcp(host, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// Does host:port behave like an HTTP proxy? CONNECT to an IP so no DNS is involved.
function proxyConnectWorks(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let buffer = '';
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('error', () => done(false));
    socket.once('close', () => done(false)); // non-proxies often just hang up on CONNECT
    socket.once('connect', () => socket.write('CONNECT 1.1.1.1:443 HTTP/1.1\r\nHost: 1.1.1.1:443\r\n\r\n'));
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.includes('\r\n')) done(/^HTTP\/1\.[01] 200/.test(buffer));
    });
  });
}

async function routeInterface(ip) {
  const out = await sh('/sbin/route', ['-n', 'get', ip]).catch(() => '');
  return /interface: (\S+)/.exec(out)?.[1] || null;
}

function vpnInterfaces() {
  return Object.entries(os.networkInterfaces())
    .filter(([name, addrs]) => /^(utun|ipsec|ppp|tun|tap)/.test(name) && addrs.some((a) => a.family === 'IPv4'))
    .map(([name]) => name);
}

function isTunnelInterface(name) {
  return /^(utun|ipsec|ppp|tun|tap)/.test(name || '');
}

async function macHasInternet() {
  // Deliberately DNS-free so it gives the right answer while the Mac's DNS is broken.
  return (await probeTcp('1.1.1.1', 443, 3000)) || probeTcp('8.8.8.8', 443, 3000);
}

// ---------------------------------------------------------------------------
// Upstream debugging proxy detection
// ---------------------------------------------------------------------------

export function parseProxySettings(out) {
  const result = { proxy: null, pac: null, autoDiscovery: /ProxyAutoDiscoveryEnable : 1/.test(out) };
  if (/ProxyAutoConfigEnable : 1/.test(out)) result.pac = /ProxyAutoConfigURLString : (\S+)/.exec(out)?.[1] || '(no URL)';
  for (const kind of ['HTTPS', 'HTTP']) {
    if (new RegExp(`${kind}Enable : 1`).test(out)) {
      const host = new RegExp(`${kind}Proxy : (\\S+)`).exec(out)?.[1];
      const port = Number(new RegExp(`${kind}Port : (\\d+)`).exec(out)?.[1]);
      if (host && port) {
        result.proxy = { host, port };
        break;
      }
    }
  }
  return result;
}

async function proxySettings() {
  return parseProxySettings(await sh('/usr/sbin/scutil', ['--proxy']).catch(() => ''));
}

async function systemProxy() {
  return (await proxySettings()).proxy;
}

// Listening TCP sockets with the owning process' full command line.
async function listeningProcesses() {
  const out = await sh('/usr/sbin/lsof', ['+c', '0', '-nP', '-iTCP', '-sTCP:LISTEN']).catch(() => '');
  const sockets = [];
  for (const line of out.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9) continue;
    const pid = Number(cols[1]);
    const address = cols[cols.length - 2];
    const port = Number(/:(\d+)$/.exec(address)?.[1]);
    const host = address.replace(/:\d+$/, '');
    if (!port || !(host === '*' || isLoopback(host.replace(/[[\]]/g, '')))) continue;
    sockets.push({ pid, command: cols[0], port });
  }
  const pids = [...new Set(sockets.map((s) => s.pid))];
  const args = new Map();
  if (pids.length) {
    const ps = await sh('/bin/ps', ['-o', 'pid=,args=', '-p', pids.join(',')]).catch(() => '');
    for (const line of ps.split('\n')) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (match) args.set(Number(match[1]), match[2]);
    }
  }
  return sockets.map((s) => ({ ...s, args: args.get(s.pid) || s.command }));
}

function toolNameFor(proc) {
  return KNOWN_PROXY_TOOLS.find((tool) => tool.match.test(`${proc.command} ${proc.args}`))?.name || null;
}

let upstreamInfo = { at: 0, upstream: null };

async function detectUpstream() {
  const setting = state.upstream || 'auto';
  if (setting === 'none') return null;
  if (setting !== 'auto') {
    const [host, port] = setting.split(':');
    return { host, port: Number(port), name: 'manual', source: 'emunet upstream' };
  }
  const listeners = await listeningProcesses();

  // 1. The macOS system proxy, if a tool set it (Proxyman, Charles, Fiddler … do).
  const system = await systemProxy();
  if (system && !(isLoopback(system.host) && system.port === state.proxyPort)) {
    const owner = listeners.find((l) => l.port === system.port);
    if (owner || !isLoopback(system.host)) {
      return { ...system, name: owner ? toolNameFor(owner) || owner.command : 'system proxy', source: 'system proxy' };
    }
  }

  // 2. A known debugging proxy that is listening but did not touch the system proxy.
  for (const tool of KNOWN_PROXY_TOOLS) {
    const ports = listeners.filter((l) => l.port !== state.proxyPort && tool.match.test(`${l.command} ${l.args}`)).map((l) => l.port);
    const ordered = [...new Set([...tool.ports.filter((p) => ports.includes(p)), ...ports])];
    for (const port of ordered) {
      if (tool.ports.includes(port) || (await proxyConnectWorks('127.0.0.1', port, 1500))) {
        return { host: '127.0.0.1', port, name: tool.name, source: 'detected' };
      }
    }
  }
  return null;
}

async function refreshUpstream() {
  upstreamInfo = { at: Date.now(), upstream: await detectUpstream().catch(() => null) };
  return upstreamInfo.upstream;
}

// Called per connection: cheap (cached detection + cached liveness probe).
let liveness = { key: '', at: 0, up: false };

async function activeUpstream() {
  if (Date.now() - upstreamInfo.at > 5000) await refreshUpstream();
  const upstream = upstreamInfo.upstream;
  if (!upstream) return null;
  const key = `${upstream.host}:${upstream.port}`;
  if (liveness.key !== key || Date.now() - liveness.at > 2000) {
    liveness = { key, at: Date.now(), up: await probeTcp(upstream.host, upstream.port) };
  }
  return liveness.up ? upstream : null;
}

function markUpstreamDown() {
  liveness = { ...liveness, at: Date.now(), up: false };
}

// ---------------------------------------------------------------------------
// Organisation-managed network security (DNS filtering, secure web gateways, ZTNA).
// When one is present emunet never changes the Mac's DNS or proxy settings, and answers
// emulator DNS through the system resolver so the company's DNS policy still applies.
// ---------------------------------------------------------------------------

const SECURITY_AGENTS = [
  { name: 'Zscaler', match: /zscaler|zstunnel/i },
  { name: 'Cisco Umbrella / Secure Client', match: /umbrella|acumbrella|acsock|com\.cisco\.anyconnect|cisco secure client/i },
  { name: 'Netskope', match: /netskope|nsauxiliarysvc|stagentsvc/i },
  { name: 'Cloudflare WARP / Zero Trust', match: /cloudflare ?warp|com\.cloudflare\.1dot1dot1dot1/i },
  { name: 'Palo Alto GlobalProtect', match: /globalprotect|pangps|com\.paloaltonetworks/i },
  { name: 'Forcepoint', match: /forcepoint|websense/i },
  { name: 'Jamf Trust / Wandera', match: /jamf ?trust|com\.jamf\.trust|wandera/i },
  { name: 'Check Point Harmony', match: /check ?point|harmony ?(sase|connect)|perimeter ?81/i },
];

let managedNetwork = { detected: false, agents: [], at: 0 };
// While the Mac's own DNS points at emunet, the system resolver would loop back to us.
let macDnsPointsAtUs = false;

export function detectAgents(text) {
  return SECURITY_AGENTS.filter((agent) => agent.match.test(text)).map((agent) => agent.name);
}

async function refreshManagedNetwork(force = false) {
  if (!force && Date.now() - managedNetwork.at < 60000) return managedNetwork;
  let text;
  if (process.env.EMUNET_FAKE_AGENTS !== undefined) {
    text = process.env.EMUNET_FAKE_AGENTS;
  } else {
    const [procs, extensions] = await Promise.all([
      sh('/bin/ps', ['-axo', 'comm=']).catch(() => ''),
      sh('/usr/bin/systemextensionsctl', ['list']).catch(() => ''),
    ]);
    text = `${procs}\n${extensions}`;
  }
  const agents = detectAgents(text);
  managedNetwork = { detected: agents.length > 0, agents, at: Date.now() };
  return managedNetwork;
}

function policyMessage() {
  return `Your organization manages this Mac's network security with ${managedNetwork.agents.join(', ')}. `
    + 'emunet will not change the Mac\'s DNS or proxy settings. Ask your IT team if you need a change.';
}

// ---------------------------------------------------------------------------
// HTTP / CONNECT proxy
// ---------------------------------------------------------------------------

const stats = { connect: 0, http: 0, viaUpstream: 0, direct: 0, errors: 0, dnsQueries: 0, dnsFail: 0 };

function splitHostPort(value, defaultPort) {
  const match = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(value || '');
  return { host: match?.[1] || value, port: Number(match?.[2]) || defaultPort };
}

function rawHeaderBlock(req) {
  const lines = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
  }
  return lines.join('\r\n');
}

function tunnel(a, b) {
  a.pipe(b);
  b.pipe(a);
  const close = () => {
    a.destroy();
    b.destroy();
  };
  a.on('error', close);
  b.on('error', close);
  a.on('close', close);
  b.on('close', close);
}

function connectDirect(req, clientSocket, head) {
  const { host, port } = splitHostPort(req.url, 443);
  const serverSocket = net.connect({ host, port, lookup: emunetLookup });
  serverSocket.setTimeout(20000, () => serverSocket.destroy(new Error('connect timeout')));
  serverSocket.once('connect', () => {
    serverSocket.setTimeout(0);
    if (clientSocket.destroyed) {
      serverSocket.destroy();
      return;
    }
    stats.direct += 1;
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) serverSocket.write(head);
    tunnel(clientSocket, serverSocket);
  });
  serverSocket.once('error', (error) => {
    stats.errors += 1;
    if (clientSocket.writable) {
      clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\nX-Emunet-Error: ${error.code || error.message}\r\n\r\n`);
    }
  });
}

async function handleConnect(req, clientSocket, head) {
  stats.connect += 1;
  clientSocket.on('error', () => {});
  const upstream = await activeUpstream();
  if (!upstream) {
    connectDirect(req, clientSocket, head);
    return;
  }
  const socket = net.connect({ host: upstream.host, port: upstream.port });
  let connected = false;
  socket.once('connect', () => {
    connected = true;
    if (clientSocket.destroyed) {
      socket.destroy();
      return;
    }
    stats.viaUpstream += 1;
    socket.write(`CONNECT ${req.url} HTTP/1.1\r\n${rawHeaderBlock(req)}\r\n\r\n`);
    if (head?.length) socket.write(head);
    tunnel(clientSocket, socket);
  });
  socket.once('error', () => {
    if (connected) return;
    // The debugging proxy went away right now: fall back to direct.
    markUpstreamDown();
    connectDirect(req, clientSocket, head);
  });
}

function forwardHttp(req, res, upstream) {
  let target;
  try {
    target = new URL(req.url);
  } catch {
    res.writeHead(400);
    res.end('bad request URL\n');
    return;
  }
  const options = upstream
    ? { host: upstream.host, port: upstream.port, path: req.url }
    : { host: target.hostname, port: target.port || 80, path: target.pathname + target.search, lookup: emunetLookup };
  const proxyReq = http.request({ ...options, method: req.method, headers: req.headers, agent: false }, (proxyRes) => {
    if (upstream) stats.viaUpstream += 1;
    else stats.direct += 1;
    res.writeHead(proxyRes.statusCode, proxyRes.rawHeaders);
    proxyRes.pipe(res);
  });
  proxyReq.setTimeout(30000, () => proxyReq.destroy(new Error('timeout')));
  proxyReq.on('error', (error) => {
    if (upstream && !res.headersSent && ['GET', 'HEAD'].includes(req.method)) {
      markUpstreamDown();
      forwardHttp(req, res, null);
      return;
    }
    stats.errors += 1;
    if (!res.headersSent) res.writeHead(502, { 'X-Emunet-Error': error.code || error.message });
    res.end();
  });
  req.pipe(proxyReq);
}

async function handleRequest(req, res) {
  if (!/^https?:\/\//i.test(req.url)) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(`${JSON.stringify(await statusSnapshot(), null, 2)}\n`);
    return;
  }
  stats.http += 1;
  forwardHttp(req, res, await activeUpstream());
}

// ---------------------------------------------------------------------------
// DNS forwarder (UDP + TCP :53, loopback clients only)
//
// Raw queries go to the VPN's DNS first (through the tunnel, chosen by the routing table),
// then the network's DHCP DNS, then public resolvers. It never asks the macOS resolver, so
// pointing the Mac's own DNS at 127.0.0.1 cannot loop.
//
// Why the Mac needs this: some VPN clients (e.g. OpenVPN Connect) write the VPN's DNS servers
// onto the Wi-Fi service. When macOS later scopes that resolver to en0 (any proxy/network
// change can trigger it), mDNSResponder binds queries to en0 (IP_BOUND_IF); they leave outside
// the tunnel and are lost, so every lookup fails while ping still works.
// ---------------------------------------------------------------------------

export const PUBLIC_DNS = ['1.1.1.1', '8.8.8.8'];

// Upstream model. Servers are "ip" or "ip:port".
//   supplemental: per-domain resolvers macOS knows about (VPN match domains, /etc/resolver/*) —
//                 a query for such a domain goes there first, like mDNSResponder would do.
//   defaults:     the default resolvers the network services ask for (VPN-provided first).
//   dhcp:         the DNS the current network handed out (survives a VPN overwriting it).
//   vpnDomains:   the VPN's own DomainName / SearchDomains — its NXDOMAIN for these is final.
let dnsModel = { supplemental: [], defaults: [], dhcp: [], vpn: [], vpnDomains: [], public: null, updatedAt: 0 };

function splitServer(server) {
  const [host, port] = server.split(':');
  return { host, port: Number(port) || 53 };
}

// Parse `scutil --dns` (the unscoped section) into resolver blocks.
export function parseScutilDns(text) {
  const unscoped = text.split('DNS configuration (for scoped queries)')[0];
  return unscoped
    .split(/\n(?=resolver #\d+)/)
    .filter((block) => block.startsWith('resolver #'))
    .map((block) => {
      const port = Number(/^\s*port\s*:\s*(\d+)/m.exec(block)?.[1]) || 53;
      const servers = [...block.matchAll(/nameserver\[\d+\]\s*:\s*(\S+)/g)]
        .map((m) => m[1])
        .filter((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip))
        .map((ip) => (port === 53 ? ip : `${ip}:${port}`));
      return {
        domain: /^\s*domain\s*:\s*(\S+)/m.exec(block)?.[1]?.replace(/\.$/, '').toLowerCase() || null,
        servers,
        mdns: /options\s*:.*\bmdns\b/.test(block),
        ifName: /if_index : \d+ \((\S+)\)/.exec(block)?.[1] || null,
      };
    });
}

function isOwnServer(server) {
  const { host, port } = splitServer(server);
  return isLoopback(host) && port === state.dnsPort;
}

async function refreshDnsUpstreams() {
  if (process.env.EMUNET_DNS_MODEL) {
    dnsModel = { supplemental: [], defaults: [], dhcp: [], vpn: [], vpnDomains: [], public: null, ...JSON.parse(process.env.EMUNET_DNS_MODEL), updatedAt: Date.now() };
    return;
  }
  const resolvers = parseScutilDns(await sh('/usr/sbin/scutil', ['--dns']).catch(() => ''));
  const supplemental = resolvers
    .filter((r) => r.domain && !r.mdns && r.servers.length)
    .map((r) => ({ domain: r.domain, servers: r.servers.filter((s) => !isOwnServer(s)) }))
    .filter((r) => r.servers.length);

  // Default resolvers: the service DNS keys without match domains (what VPN clients and DHCP write).
  // With `mac-dns on` the global default is 127.0.0.1, so it has to come from these keys.
  const keys = (await scutilRun('list State:/Network/Service/[^/]+/DNS\n')).match(/State:\/Network\/Service\/\S+\/DNS/g) || [];
  const candidates = [];
  const domainsByServer = new Map();
  for (const key of keys) {
    const dict = await scutilShow(key);
    if (/SupplementalMatchDomains/.test(dict)) continue;
    const servers = ipv4List(/ServerAddresses : <array> \{([^}]*)\}/.exec(dict)?.[1] || '');
    const domains = [
      /DomainName : (\S+)/.exec(dict)?.[1],
      ...[...(/SearchDomains : <array> \{([^}]*)\}/.exec(dict)?.[1] || '').matchAll(/\d+ : (\S+)/g)].map((m) => m[1]),
    ].filter(Boolean).map((d) => d.toLowerCase().replace(/\.$/, ''));
    for (const server of servers) domainsByServer.set(server, [...(domainsByServer.get(server) || []), ...domains]);
    candidates.push(...servers);
  }
  const globalDefault = resolvers.find((r) => !r.domain)?.servers || [];
  const all = [...new Set([...candidates, ...globalDefault])].filter((s) => !isOwnServer(s));
  const vpn = [];
  for (const server of all) {
    if (isTunnelInterface(await routeInterface(splitServer(server).host))) vpn.push(server);
  }
  const defaults = [...vpn, ...all.filter((s) => !vpn.includes(s))];
  const iface = /PrimaryInterface : (\S+)/.exec(await scutilShow('State:/Network/Global/IPv4'))?.[1] || 'en0';
  const dhcp = ipv4List(await sh('/usr/sbin/ipconfig', ['getoption', iface, 'domain_name_server']).catch(() => ''));
  const vpnDomains = [...new Set(vpn.flatMap((server) => domainsByServer.get(server) || []))];
  dnsModel = { supplemental, defaults, dhcp, vpn, vpnDomains, updatedAt: Date.now() };
}

function inDomains(name, domains) {
  const lower = (name || '').toLowerCase().replace(/\.$/, '');
  return (domains || []).some((d) => lower === d || lower.endsWith(`.${d}`));
}

function matchSupplemental(name) {
  const lower = (name || '').toLowerCase().replace(/\.$/, '');
  return (dnsModel.supplemental || [])
    .filter((r) => lower === r.domain || lower.endsWith(`.${r.domain}`))
    .sort((a, b) => b.domain.length - a.domain.length)[0] || null;
}

// The ordered server list for a name, each tagged with the tier it came from.
export function serversFor(name) {
  const out = [];
  const add = (servers, tier) => {
    for (const server of servers) if (!out.some((o) => o.server === server)) out.push({ server, tier });
  };
  const match = matchSupplemental(name);
  if (match) add(match.servers, 'match');
  add(dnsModel.defaults, 'default');
  add(dnsModel.dhcp, 'dhcp');
  add(dnsModel.public || PUBLIC_DNS, 'public');
  return out;
}

function dnsServerOrder() {
  return serversFor('').map((s) => s.server);
}

function forwardUdp(query, server, timeoutMs) {
  const { host, port } = splitServer(server);
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('timeout'));
    }, timeoutMs);
    socket.once('message', (response) => {
      clearTimeout(timer);
      socket.close();
      resolve(response);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
    socket.send(query, port, host);
  });
}

function forwardTcp(query, server, timeoutMs) {
  const { host, port } = splitServer(server);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const chunks = [];
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('timeout')));
    socket.once('connect', () => {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(query.length);
      socket.write(Buffer.concat([length, query]));
    });
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      if (buffer.length >= 2 && buffer.length >= 2 + buffer.readUInt16BE(0)) {
        socket.destroy();
        resolve(buffer.subarray(2, 2 + buffer.readUInt16BE(0)));
      }
    });
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('closed'))); // no-op if already resolved
  });
}

export function queryName(msg) {
  const labels = [];
  let offset = 12;
  while (offset < msg.length && msg[offset] !== 0) {
    const len = msg[offset];
    if (len & 0xc0) return null;
    labels.push(msg.subarray(offset + 1, offset + 1 + len).toString('latin1'));
    offset += len + 1;
  }
  return labels.join('.');
}

const RCODE = { NOERROR: 0, SERVFAIL: 2, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5 };

// Ask the servers in order. A server that fails, refuses or SERVFAILs is skipped. NXDOMAIN is
// final when it comes from the resolver that owns the name: a match-domain resolver, or the VPN
// DNS for the VPN's own domains (otherwise a router that "helpfully" answers unknown names would
// win). For other names a default resolver's NXDOMAIN is double-checked with the network's own
// DNS (split-horizon VPN DNS often NXDOMAINs public names), but never with public resolvers, so
// internal names do not leak to the internet.
export async function resolveRaw(query, transport = 'udp', { timeoutMs } = {}) {
  const name = queryName(query);
  let fallbackNx = null;
  let nxFromDefault = false;
  for (const { server, tier } of serversFor(name)) {
    if (nxFromDefault && tier === 'public') break;
    let response;
    try {
      const timeout = timeoutMs || (dnsModel.vpn.includes(server) ? 2500 : 2000);
      response = transport === 'tcp' ? await forwardTcp(query, server, timeout) : await forwardUdp(query, server, timeout);
    } catch {
      continue;
    }
    if (response.length < 12 || response.readUInt16BE(0) !== query.readUInt16BE(0)) continue;
    const rcode = response[3] & 0x0f;
    if ([RCODE.SERVFAIL, RCODE.NOTIMP, RCODE.REFUSED].includes(rcode)) continue;
    const owns = tier === 'match' || (dnsModel.vpn.includes(server) && inDomains(name, dnsModel.vpnDomains));
    if (rcode === RCODE.NXDOMAIN && !owns) {
      fallbackNx ||= response;
      if (tier === 'default') nxFromDefault = true;
      continue;
    }
    return response;
  }
  if (fallbackNx) return fallbackNx;
  throw new Error('no DNS server answered');
}

// When the organisation runs a DNS/network security agent, answer from the system resolver
// instead of talking to DNS servers directly, so the company's DNS policy still applies.
async function resolveViaSystem(query) {
  const name = queryName(query);
  const type = query.readUInt16BE(12 + (name ? name.length + 2 : 1));
  const header = Buffer.from(query.subarray(0, 12));
  header[2] = 0x80 | (query[2] & 0x79);
  const question = query.subarray(12, 12 + (name ? name.length + 2 : 1) + 4);
  if (type !== 1) {
    header[3] = 0x80;
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(0, 6);
    header.writeUInt16BE(0, 8);
    header.writeUInt16BE(0, 10);
    return Buffer.concat([header, question]);
  }
  const addresses = await withTimeout(
    new Promise((resolve) => dns.lookup(name, { all: true, family: 4 }, (error, list) => resolve(error ? error : list.map((a) => a.address)))),
    5000,
    new Error('timeout'),
  );
  if (addresses instanceof Error) {
    header[3] = 0x80 | (['ENOTFOUND', 'ENODATA'].includes(addresses.code) ? RCODE.NXDOMAIN : RCODE.SERVFAIL);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(0, 6);
    header.writeUInt16BE(0, 8);
    header.writeUInt16BE(0, 10);
    return Buffer.concat([header, question]);
  }
  header[3] = 0x80;
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(addresses.length, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  const answers = addresses.map((address) => {
    const answer = Buffer.alloc(16);
    answer.writeUInt16BE(0xc00c, 0);
    answer.writeUInt16BE(1, 2);
    answer.writeUInt16BE(1, 4);
    answer.writeUInt32BE(30, 6);
    answer.writeUInt16BE(4, 10);
    address.split('.').forEach((octet, i) => {
      answer[12 + i] = Number(octet);
    });
    return answer;
  });
  return Buffer.concat([header, question, ...answers]);
}

function healthAnswer(query) {
  const name = queryName(query);
  const question = query.subarray(12, 12 + name.length + 2 + 4);
  const header = Buffer.from(query.subarray(0, 12));
  header[2] = 0x80 | (query[2] & 0x79);
  header[3] = 0x80;
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(1, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  const answer = Buffer.alloc(16);
  answer.writeUInt16BE(0xc00c, 0);
  answer.writeUInt16BE(1, 2);
  answer.writeUInt16BE(1, 4);
  answer.writeUInt32BE(0, 6);
  answer.writeUInt16BE(4, 10);
  HEALTH_ADDRESS.split('.').forEach((octet, i) => {
    answer[12 + i] = Number(octet);
  });
  return Buffer.concat([header, question, answer]);
}

async function answerQuery(query, transport) {
  if (queryName(query)?.toLowerCase() === HEALTH_NAME) return healthAnswer(query);
  if (managedNetwork.detected && !macDnsPointsAtUs) return resolveViaSystem(query);
  return resolveRaw(query, transport);
}

export function buildQuery(name, type = 1) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(Math.floor(Math.random() * 0xffff), 0);
  header.writeUInt16BE(0x0100, 2); // RD
  header.writeUInt16BE(1, 4);
  const labels = name.split('.').filter(Boolean).map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]));
  const tail = Buffer.alloc(5);
  tail.writeUInt16BE(type, 1);
  tail.writeUInt16BE(1, 3);
  return Buffer.concat([header, ...labels, tail]);
}

function skipName(msg, offset) {
  while (offset < msg.length) {
    const len = msg[offset];
    if (len === 0) return offset + 1;
    if ((len & 0xc0) === 0xc0) return offset + 2;
    offset += len + 1;
  }
  return offset;
}

export function parseARecords(msg) {
  const questions = msg.readUInt16BE(4);
  const answers = msg.readUInt16BE(6);
  let offset = 12;
  for (let i = 0; i < questions; i += 1) offset = skipName(msg, offset) + 4;
  const addresses = [];
  for (let i = 0; i < answers && offset + 10 <= msg.length; i += 1) {
    offset = skipName(msg, offset);
    const type = msg.readUInt16BE(offset);
    const length = msg.readUInt16BE(offset + 8);
    offset += 10;
    if (type === 1 && length === 4) addresses.push([...msg.subarray(offset, offset + 4)].join('.'));
    offset += length;
  }
  return addresses;
}

// The proxy's direct connections resolve through the forwarder too, so emulator traffic keeps
// flowing while the macOS resolver is broken. Falls back to the system resolver.
function emunetLookup(hostname, options, callback) {
  const opts = typeof options === 'function' ? {} : options || {};
  const cb = typeof options === 'function' ? options : callback;
  if (net.isIP(hostname)) {
    const result = { address: hostname, family: net.isIP(hostname) };
    return opts.all ? cb(null, [result]) : cb(null, result.address, result.family);
  }
  if (managedNetwork.detected && !macDnsPointsAtUs) return dns.lookup(hostname, opts, cb);
  resolveRaw(buildQuery(hostname), 'udp')
    .then((response) => {
      const addresses = parseARecords(response);
      if (!addresses.length) throw new Error('no A record');
      if (opts.all) cb(null, addresses.map((address) => ({ address, family: 4 })));
      else cb(null, addresses[0], 4);
    })
    .catch(() => dns.lookup(hostname, opts, cb));
}

function servfail(query) {
  const response = Buffer.from(query);
  response[2] = 0x80 | (query[2] & 0x79); // QR, keep opcode + RD
  response[3] = 0x80 | 2; // RA + SERVFAIL
  response.writeUInt16BE(0, 6);
  response.writeUInt16BE(0, 8);
  response.writeUInt16BE(0, 10);
  return response;
}

let dnsListening = false;

function startDns() {
  refreshDnsUpstreams().catch(() => {});
  bindDns();
}

// If port 53 is taken (dnsmasq, AdGuard…), keep the proxy running and retry every 30 s.
function bindDns(attempt = 0) {
  const retry = (what, error) => {
    if (attempt === 0) log(`cannot listen for DNS (${what}) on :${state.dnsPort} (${error.code || error.message}); proxy keeps running, retrying every 30 s`);
    setTimeout(() => bindDns(attempt + 1), 30000).unref?.();
  };
  const udp = dgram.createSocket('udp4');
  let bound = false;
  udp.on('error', (error) => {
    if (!bound) {
      udp.close();
      retry('udp', error);
      return;
    }
    log(`DNS socket error: ${error.code || error.message}`);
  });
  udp.on('message', async (msg, rinfo) => {
    // Bound to 0.0.0.0 (macOS only lets non-root processes bind :53 that way); never answer the LAN.
    if (!isLoopback(rinfo.address) || msg.length < 12) return;
    stats.dnsQueries += 1;
    let response;
    try {
      response = await answerQuery(msg, 'udp');
    } catch {
      stats.dnsFail += 1;
      response = servfail(msg);
    }
    udp.send(response, rinfo.port, rinfo.address, () => {});
  });
  udp.bind(state.dnsPort, '0.0.0.0', () => {
    bound = true;
    const tcp = net.createServer((socket) => {
      if (!isLoopback(socket.remoteAddress || '')) {
        socket.destroy();
        return;
      }
      let buffer = Buffer.alloc(0);
      socket.on('error', () => {});
      socket.on('data', async (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2 && buffer.length >= 2 + buffer.readUInt16BE(0)) {
          const query = buffer.subarray(2, 2 + buffer.readUInt16BE(0));
          buffer = buffer.subarray(2 + query.length);
          if (query.length < 12) continue;
          stats.dnsQueries += 1;
          let response;
          try {
            response = await answerQuery(query, 'tcp');
          } catch {
            stats.dnsFail += 1;
            response = servfail(query);
          }
          const length = Buffer.alloc(2);
          length.writeUInt16BE(response.length);
          if (socket.writable) socket.write(Buffer.concat([length, response]));
        }
      });
    });
    tcp.on('error', (error) => {
      // UDP works; DNS over TCP (large answers) is unavailable. Log it, keep UDP.
      log(`cannot listen for DNS (tcp) on :${state.dnsPort} (${error.code || error.message}); UDP DNS keeps working`);
    });
    tcp.listen(state.dnsPort, '0.0.0.0', () => {
      dnsListening = true;
      log(`DNS forwarder listening on :${state.dnsPort} udp+tcp (loopback clients only)`);
    });
  });
}

// ---------------------------------------------------------------------------
// Emulators
// ---------------------------------------------------------------------------

async function adb(serial, ...args) {
  const { stdout } = await execFileAsync(ADB, ['-s', serial, ...args], { timeout: 15000, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

async function listEmulators() {
  try {
    const { stdout } = await execFileAsync(ADB, ['devices'], { timeout: 10000 });
    return stdout
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter(([serial, status]) => serial?.startsWith('emulator-') && status === 'device')
      .map(([serial]) => serial);
  } catch {
    return [];
  }
}

async function emulatorProcesses() {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,args='], { maxBuffer: 8 * 1024 * 1024 });
    return stdout
      .split('\n')
      .filter((line) => /qemu-system.*-avd /.test(line))
      .map((line) => {
        const dnsServer = /-dns-server (\S+)/.exec(line)?.[1] || null;
        return {
          pid: Number(line.trim().split(/\s+/)[0]),
          avd: /-avd (\S+)/.exec(line)?.[1],
          dnsServer,
          dnsOk: dnsServer === '127.0.0.1',
        };
      });
  } catch {
    return [];
  }
}

async function bootedSimulators() {
  const out = await sh('/usr/bin/xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], 10000).catch(() => '');
  try {
    return Object.values(JSON.parse(out).devices || {}).flat().filter((d) => d.state === 'Booted').map((d) => d.name);
  } catch {
    return [];
  }
}

async function emulatorAvdName(serial) {
  return (await adb(serial, 'emu', 'avd', 'name').catch(() => '')).split('\n')[0].trim();
}

async function wifiValidated(serial) {
  const out = await adb(serial, 'shell', 'dumpsys', 'connectivity');
  const wifiLine = out.split('\n').find((line) => line.includes('NetworkAgentInfo{') && line.includes('ni{WIFI'));
  const caps = wifiLine && /Capabilities: (\S+)/.exec(wifiLine)?.[1];
  return caps ? caps.split('&').includes('VALIDATED') : null;
}

async function emulatorResolves(serial) {
  const out = await adb(serial, 'shell', 'ping', '-c1', '-W3', 'www.google.com').catch((error) => `${error.stdout || ''}${error.stderr || ''}`);
  return !/unknown host|bad address/i.test(out) && /PING/.test(out);
}

async function kickWifi(serial, reason) {
  if (DRY_RUN) {
    console.log(`   [dry-run] adb -s ${serial} shell svc wifi disable/enable`);
    return;
  }
  log(`${serial}: restarting Wi-Fi to re-run network validation (${reason})`);
  await adb(serial, 'shell', 'svc', 'wifi', 'disable').catch(() => {});
  await sleep(2500);
  await adb(serial, 'shell', 'svc', 'wifi', 'enable').catch(() => {});
}

// ---------------------------------------------------------------------------
// Supervisor (daemon)
// ---------------------------------------------------------------------------

let netState = { vpn: null, upstream: null };
const emulatorChecks = new Map(); // serial -> { unvalidatedSince, lastKick }

async function superviseEmulator(serial, networkChanged) {
  const wanted = `10.0.2.2:${state.proxyPort}`;
  const current = await adb(serial, 'shell', 'settings', 'get', 'global', 'http_proxy').catch(() => null);
  if (current !== null && current !== wanted) {
    await adb(serial, 'shell', 'settings', 'put', 'global', 'http_proxy', wanted);
    log(`${serial}: http_proxy ${current || '(empty)'} → ${wanted}`);
    networkChanged = true;
  }

  const check = emulatorChecks.get(serial) || { unvalidatedSince: 0, lastKick: 0 };
  const validated = await wifiValidated(serial).catch(() => null);
  if (validated === false) {
    check.unvalidatedSince ||= Date.now();
    const stuckFor = Date.now() - check.unvalidatedSince;
    const sinceKick = Date.now() - check.lastKick;
    if ((networkChanged || stuckFor > 20000) && sinceKick > 120000 && (await macHasInternet())) {
      check.lastKick = Date.now();
      await kickWifi(serial, networkChanged ? 'network changed' : `unvalidated for ${Math.round(stuckFor / 1000)}s`);
    }
  } else {
    check.unvalidatedSince = 0;
  }
  emulatorChecks.set(serial, check);
}

function describeUpstream(upstream) {
  return upstream ? `${upstream.name} ${upstream.host}:${upstream.port}` : 'none (direct)';
}

async function superviseTick() {
  state = loadState();
  await refreshDnsUpstreams().catch(() => {});
  await refreshManagedNetwork().catch(() => {});
  const primary = await primaryService().catch(() => null);
  macDnsPointsAtUs = primary?.dnsServers.includes('127.0.0.1') || false;
  await syncGuard(primary).catch((error) => log(`mac-dns watchdog: ${error.message}`));
  await refreshUpstream();
  const vpn = vpnInterfaces().join(',') || 'none';
  const upstream = describeUpstream(await activeUpstream());
  const changed = netState.vpn !== null && (netState.vpn !== vpn || netState.upstream !== upstream);
  if (netState.vpn !== vpn || netState.upstream !== upstream) {
    log(`network: VPN=${vpn}  upstream proxy=${upstream}`);
  }
  netState = { vpn, upstream };
  if (!state.manageEmulators) return;
  for (const serial of await listEmulators()) {
    await superviseEmulator(serial, changed).catch((error) => log(`${serial}: ${error.message}`));
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

async function primaryService() {
  if (process.env.EMUNET_FAKE_SERVICE) return JSON.parse(process.env.EMUNET_FAKE_SERVICE);
  const uuid = /PrimaryService : (\S+)/.exec(await scutilShow('State:/Network/Global/IPv4'))?.[1];
  if (!uuid) return null;
  const name = /UserDefinedName : (.+)/.exec(await scutilShow(`Setup:/Network/Service/${uuid}`))?.[1]?.trim();
  if (!name) return null;
  return { name, dnsServers: await serviceDnsServers(name) };
}

// The manual DNS servers of a network service, IPv4 and IPv6, exactly as configured ([] = automatic).
export function parseDnsServersOutput(out) {
  return out.split('\n').map((line) => line.trim()).filter((line) => /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f:]*:[0-9a-f:.]*(%\w+)?)$/i.test(line));
}

async function serviceDnsServers(name) {
  if (process.env.EMUNET_FAKE_SERVICE) {
    const fake = JSON.parse(process.env.EMUNET_FAKE_SERVICE) || {};
    if (fake.name === name) return fake.dnsServers;
    return (fake.others || {})[name] || [];
  }
  return parseDnsServersOutput(await sh(NETWORKSETUP, ['-getdnsservers', name]).catch(() => ''));
}

async function statusSnapshot() {
  const emulators = [];
  for (const serial of await listEmulators()) {
    emulators.push({
      serial,
      httpProxy: await adb(serial, 'shell', 'settings', 'get', 'global', 'http_proxy').catch(() => null),
      wifiValidated: await wifiValidated(serial).catch(() => null),
    });
  }
  return {
    version: VERSION,
    proxy: `127.0.0.1:${state.proxyPort} (10.0.2.2:${state.proxyPort} from emulators)`,
    upstreamSetting: state.upstream,
    upstream: await activeUpstream(),
    vpn: vpnInterfaces(),
    manageEmulators: state.manageEmulators,
    emulators,
    emulatorProcesses: await emulatorProcesses(),
    dnsServers: dnsServerOrder(),
    vpnDns: dnsModel.vpn,
    mac: await primaryService(),
    managedNetwork: (await refreshManagedNetwork()).agents,
    dnsGuard: await guardLoaded(),
    stats,
  };
}

async function fetchStatus() {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: state.proxyPort, path: '/__emunet/status', timeout: 20000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

// ---------------------------------------------------------------------------
// Privileged changes (run by the user; prompts for sudo when needed)
// ---------------------------------------------------------------------------

async function privileged(cmd, args) {
  if (DRY_RUN) {
    console.log(`   [dry-run] ${path.basename(cmd)} ${args.join(' ')}`);
    return true;
  }
  try {
    await execFileAsync(cmd, args, { timeout: 15000 });
    return true;
  } catch {
    console.log(`   needs admin rights: sudo ${path.basename(cmd)} ${args.join(' ')}`);
    return spawnSync('sudo', [cmd, ...args], { stdio: 'inherit' }).status === 0;
  }
}

// Does anything at all answer DNS on 127.0.0.1:53?
async function anyDnsOn127() {
  try {
    await forwardUdp(buildQuery('apple.com'), `127.0.0.1:${state.dnsPort}`, 2500);
    return true;
  } catch {
    return false;
  }
}

// Is it really emunet that answers DNS on 127.0.0.1:53?
async function emunetDnsAnswering(timeoutMs = 3000) {
  try {
    const response = await forwardUdp(buildQuery(HEALTH_NAME), `127.0.0.1:${state.dnsPort}`, timeoutMs);
    return parseARecords(response).includes(HEALTH_ADDRESS);
  } catch {
    return false;
  }
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// A tiny watchdog that does not depend on Node or emunet: if the Mac's DNS points at 127.0.0.1
// and nothing answers there for ~10 s (emunet crashed, was uninstalled, port taken…), it puts
// the previous DNS setting back. It removes itself once emunet is gone for good.
export function guardScript({ services, dnsPort, networksetup = '/usr/sbin/networksetup', dig = '/usr/bin/dig', script, log }) {
  const entries = Object.entries(services);
  return [
    `ns=${shQuote(networksetup)}`,
    // Only emunet answers this name (with 127.0.0.77), and it never needs the network.
    `alive() { ${shQuote(dig)} +time=2 +tries=1 +short @127.0.0.1 -p ${dnsPort} ${HEALTH_NAME} 2>/dev/null | grep -q '^127\\.0\\.0\\.77$'; }`,
    'onus() { "$ns" -getdnsservers "$1" 2>/dev/null | grep -qx "127.0.0.1"; }',
    'restore() {',
    '  svc=$1; shift',
    '  onus "$svc" || return 0',
    `  "$ns" -setdnsservers "$svc" "$@" && echo "$(date '+%F %T') dnsguard: emunet DNS not answering on 127.0.0.1:${dnsPort}; restored $svc DNS to $*" >> ${shQuote(log)}`,
    '}',
    'need=0',
    ...entries.map(([name]) => `onus ${shQuote(name)} && need=1`),
    '[ "$need" = 1 ] || exit 0',
    'alive && exit 0',
    'sleep 5',
    'alive && exit 0',
    ...entries.map(([name, previous]) => `restore ${shQuote(name)} ${previous.map(shQuote).join(' ')}`),
    // emunet uninstalled: remove the plist first (bootout ends this very script).
    `[ -e ${shQuote(script)} ] || { rm -f ${shQuote(GUARD_PLIST)}; /bin/launchctl bootout "gui/$(id -u)/${GUARD_LABEL}" 2>/dev/null; }`,
    'exit 0',
  ].join('\n');
}

function guardPlist(body) {
  const esc = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${GUARD_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>-c</string><string>${esc(body)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>20</integer>
</dict>
</plist>
`;
}

function guardBody(services) {
  return guardScript({
    services,
    dnsPort: state.dnsPort,
    networksetup: process.env.EMUNET_GUARD_NETWORKSETUP || NETWORKSETUP,
    script: scriptPath(),
    log: SERVICE_LOG,
  });
}

// Run by the daemon: adopt a Mac DNS that already points at emunet (e.g. enabled by an older
// version) and keep the watchdog script current, so upgrades never leave an outdated watchdog.
async function syncGuard(primary) {
  let changed = { ...(state.macDns || {}) };
  if (primary?.dnsServers.includes('127.0.0.1') && !changed[primary.name]) {
    changed[primary.name] = ['Empty'];
    state = saveState({ macDns: changed });
    log(`mac-dns: ${primary.name} points at emunet; tracking it (restore = automatic)`);
  }
  if (!Object.keys(changed).length) return;
  const wanted = guardPlist(guardBody(changed));
  const current = fs.existsSync(GUARD_PLIST) ? fs.readFileSync(GUARD_PLIST, 'utf8') : '';
  if (current !== wanted) {
    await installGuard(changed);
    log('mac-dns watchdog installed/updated');
  }
}

async function installGuard(services) {
  const body = guardScript({
    services,
    dnsPort: state.dnsPort,
    networksetup: process.env.EMUNET_GUARD_NETWORKSETUP || NETWORKSETUP,
    script: scriptPath(),
    log: SERVICE_LOG,
  });
  fs.mkdirSync(path.dirname(GUARD_PLIST), { recursive: true });
  fs.writeFileSync(GUARD_PLIST, guardPlist(body));
  if (DRY_RUN) return;
  const uid = process.getuid();
  await execFileAsync('/bin/launchctl', ['bootout', `gui/${uid}/${GUARD_LABEL}`]).catch(() => {});
  await sleep(300);
  await execFileAsync('/bin/launchctl', ['bootstrap', `gui/${uid}`, GUARD_PLIST]).catch(() => {});
}

async function removeGuard() {
  if (!DRY_RUN) await execFileAsync('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${GUARD_LABEL}`]).catch(() => {});
  fs.rmSync(GUARD_PLIST, { force: true });
}

async function guardLoaded() {
  if (DRY_RUN) return fs.existsSync(GUARD_PLIST);
  return execFileAsync('/bin/launchctl', ['print', `gui/${process.getuid()}/${GUARD_LABEL}`]).then(() => true, () => false);
}

let macDnsError = '';

// `on`: points the primary service's DNS at emunet, remembering its previous setting per service.
// Done WITHOUT sudo on purpose: if this user cannot change DNS unprivileged, neither can the
// watchdog, so it could never undo the change — refuse instead.
// `off`: restores every service emunet changed, exactly as it was. Services emunet did not change
// are never touched.
async function setMacDns(on) {
  macDnsError = '';
  const service = await primaryService().catch(() => null);
  const changed = { ...(state.macDns || {}) };
  if (on) {
    if (!service) throw new Error('No primary network service found.');
    if (!service.dnsServers.includes('127.0.0.1')) {
      const previous = service.dnsServers.length ? service.dnsServers : ['Empty'];
      if (DRY_RUN) {
        console.log(`   [dry-run] networksetup -setdnsservers ${service.name} 127.0.0.1`);
      } else {
        try {
          await execFileAsync(NETWORKSETUP, ['-setdnsservers', service.name, '127.0.0.1'], { timeout: 15000 });
        } catch {
          macDnsError = 'This account cannot change DNS settings without an administrator password, so the safety '
            + 'watchdog would not be able to undo it. Not enabling mac-dns; use an administrator account.';
          return false;
        }
      }
      changed[service.name] = previous;
      state = saveState({ macDns: changed });
    } else if (!changed[service.name]) {
      changed[service.name] = ['Empty']; // already 127.0.0.1 before emunet tracked it
      state = saveState({ macDns: changed });
    }
    await installGuard(changed);
  } else {
    // An untracked 127.0.0.1 (older emunet, deleted state file) is ours if emunet answers there,
    // or if nothing answers at all (dead DNS must be restored). If another program answers DNS
    // normally there (dnsmasq, AdGuard…), it is the user's own setup: leave it.
    if (service && !changed[service.name] && service.dnsServers.length === 1 && service.dnsServers[0] === '127.0.0.1'
      && ((await emunetDnsAnswering()) || !(await anyDnsOn127()))) {
      changed[service.name] = ['Empty'];
    }
    let ok = true;
    for (const [name, previous] of Object.entries(changed)) {
      if (!(await serviceDnsServers(name)).includes('127.0.0.1')) continue; // user changed it since
      if (!(await privileged(NETWORKSETUP, ['-setdnsservers', name, ...previous]))) ok = false;
    }
    if (!ok) return false;
    await removeGuard();
    state = saveState({ macDns: {} });
  }
  if (!DRY_RUN) await execFileAsync('/usr/bin/dscacheutil', ['-flushcache']).catch(() => {});
  return true;
}

function macDnsSummary() {
  const entries = Object.entries(state.macDns || {});
  return entries.length ? entries.map(([name, prev]) => `${name}: ${prev.join(' ').replace('Empty', 'automatic')}`).join(', ') : 'automatic';
}

async function setSystemProxyOff() {
  const service = await primaryService();
  if (!service) return false;
  const http1 = await privileged(NETWORKSETUP, ['-setwebproxystate', service.name, 'off']);
  const https1 = await privileged(NETWORKSETUP, ['-setsecurewebproxystate', service.name, 'off']);
  return http1 && https1;
}

async function startDaemon() {
  if (isBrewInstall()) {
    await execFileAsync('brew', ['services', 'restart', 'emunet']).catch(() => {});
  } else {
    // Rewrites the LaunchAgent, so a Node that moved (nvm, upgrades) is picked up again.
    await installService({ quiet: true });
  }
  return waitForDaemon();
}

async function waitForDaemon() {
  for (let i = 0; i < 20; i += 1) {
    if (await probeTcp('127.0.0.1', state.proxyPort, 500)) return true;
    await sleep(500);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Background service (LaunchAgent), shared by the curl and npm installs.
// Homebrew installs are handed to `brew services`.
// ---------------------------------------------------------------------------

function scriptPath() {
  return fs.realpathSync(fileURLToPath(import.meta.url));
}

function isBrewInstall() {
  return /\/(Cellar|opt)\/emunet\//.test(scriptPath());
}

// Prefer a stable `node` on PATH (e.g. /opt/homebrew/bin/node) over the versioned Cellar path,
// so Node upgrades do not break the service.
function stableNode() {
  const dirs = [...(process.env.PATH || '').split(':'), '/opt/homebrew/bin', '/usr/local/bin'];
  return dirs.map((dir) => path.join(dir, 'node')).find((candidate) => isExecutable(candidate)) || process.execPath;
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function plistXml(node, script) {
  const esc = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(node)}</string><string>${esc(script)}</string><string>daemon</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>UV_THREADPOOL_SIZE</key><string>16</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(SERVICE_LOG)}</string>
  <key>StandardErrorPath</key><string>${esc(SERVICE_LOG)}</string>
</dict>
</plist>
`;
}

async function launchAgentLoaded() {
  if (DRY_RUN) return fs.existsSync(SERVICE_PLIST);
  return execFileAsync('/bin/launchctl', ['print', `gui/${process.getuid()}/${SERVICE_LABEL}`]).then(() => true, () => false);
}

async function bootoutAgent() {
  if (DRY_RUN) {
    console.log(`   [dry-run] launchctl bootout gui/${process.getuid()}/${SERVICE_LABEL}`);
    return;
  }
  await execFileAsync('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${SERVICE_LABEL}`]).catch(() => {});
  // bootout returns before the job is gone; bootstrapping too early fails with error 5.
  for (let i = 0; i < 50 && (await launchAgentLoaded()); i += 1) await sleep(200);
}

async function installService({ quiet = false } = {}) {
  if (isBrewInstall()) {
    const ok = spawnSync('brew', ['services', 'restart', 'emunet'], { stdio: quiet ? 'ignore' : 'inherit' }).status === 0;
    if (!quiet) console.log(ok ? 'Started with brew services.' : 'brew services failed.');
    return ok;
  }
  fs.mkdirSync(path.dirname(SERVICE_PLIST), { recursive: true });
  fs.mkdirSync(path.dirname(SERVICE_LOG), { recursive: true });
  fs.writeFileSync(SERVICE_PLIST, plistXml(stableNode(), scriptPath()));
  if (DRY_RUN) {
    console.log(`   [dry-run] launchctl bootstrap ${SERVICE_PLIST}`);
    return true;
  }
  await bootoutAgent();
  let loaded = false;
  for (let i = 0; i < 4 && !loaded; i += 1) {
    loaded = await execFileAsync('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, SERVICE_PLIST]).then(() => true, () => false);
    if (!loaded) await sleep(1000);
  }
  const up = loaded && (await waitForDaemon());
  if (!quiet) {
    console.log(up ? `emunet service running (LaunchAgent ${SERVICE_PLIST}, log ${SERVICE_LOG}).` : 'The service did not start; see the log: ' + SERVICE_LOG);
  }
  return up;
}

async function uninstallService() {
  const primary = await primaryService().catch(() => null);
  if (Object.keys(state.macDns || {}).length || primary?.dnsServers.includes('127.0.0.1')) {
    console.log('Restoring the Mac\'s DNS before removing the service.');
    await setMacDns(false);
  }
  if (isBrewInstall() && !DRY_RUN) {
    spawnSync('brew', ['services', 'stop', 'emunet'], { stdio: 'inherit' });
  }
  await bootoutAgent();
  fs.rmSync(SERVICE_PLIST, { force: true });
  console.log('emunet service removed.');
}

async function cmdService(action) {
  if (action === 'install' || action === 'start') {
    if (!(await installService())) process.exitCode = 1;
  } else if (action === 'uninstall' || action === 'stop') {
    await uninstallService();
  } else if (action === 'status' || !action) {
    const up = await probeTcp('127.0.0.1', state.proxyPort, 800);
    const how = isBrewInstall() ? 'brew services' : (await launchAgentLoaded()) ? `LaunchAgent ${SERVICE_PLIST}` : 'not installed';
    console.log(`emunet service: ${up ? 'running' : 'not running'} (${how})`);
    if (!up) process.exitCode = 1;
  } else {
    console.error('Usage: emunet service install|uninstall|status');
    process.exitCode = 1;
  }
}

function ask(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  return new Promise((resolve) => {
    process.stdout.write(`${question} [y/N] `);
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (answer) => {
      process.stdin.pause();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

// ---------------------------------------------------------------------------
// doctor / fix
// ---------------------------------------------------------------------------

const PUBLIC_NAMES = ['www.google.com', 'www.apple.com', 'cloudflare.com'];

function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, sleep(ms).then(() => fallback)]);
}

// What apps use: getaddrinfo → mDNSResponder.
async function systemDnsWorks() {
  for (const name of PUBLIC_NAMES) {
    const ok = await withTimeout(new Promise((resolve) => dns.lookup(name, { family: 4 }, (error) => resolve(!error))), 4000, false);
    if (ok) return true;
  }
  return false;
}

async function directDnsWorks() {
  for (const server of PUBLIC_DNS) {
    try {
      if (parseARecords(await forwardUdp(buildQuery('www.google.com'), server, 2500)).length) return true;
    } catch {
      // next
    }
  }
  return false;
}

async function systemResolver() {
  const out = await sh('/usr/sbin/scutil', ['--dns']).catch(() => '');
  const first = out.split(/resolver #\d+/)[1] || '';
  return {
    servers: ipv4List(first.split('\n').filter((line) => line.includes('nameserver')).join(' ')),
    ifName: /if_index : \d+ \((\S+)\)/.exec(first)?.[1] || null,
  };
}

async function cmdDoctor({ fix = false, yes = false } = {}) {
  const mark = (ok) => (ok === true ? '✓' : ok === false ? '✗' : '•');
  const say = (ok, text) => console.log(`${mark(ok)} ${text}`);
  const doing = (text) => console.log(`  → ${text}`);
  let problems = 0;
  let fixed = 0;

  // 1. Raw connectivity
  const rawNet = await macHasInternet();
  say(rawNet, `Internet (TCP to 1.1.1.1 / 8.8.8.8): ${rawNet ? 'reachable' : 'UNREACHABLE'}`);
  if (!rawNet) {
    console.log('  The network itself is down (Wi-Fi / cable / router). Nothing emunet can fix.');
    process.exitCode = 1;
    return;
  }

  // 1b. Organisation-managed network security
  await refreshManagedNetwork(true);
  if (managedNetwork.detected) {
    say(null, `Managed network security: ${managedNetwork.agents.join(', ')} — emunet will not change the Mac's DNS or proxy settings (company policy).`);
  }

  // 2. emunet service
  const service = await primaryService();
  const macDnsOnEmunet = !!service?.dnsServers.includes('127.0.0.1');
  let daemonUp = await probeTcp('127.0.0.1', state.proxyPort, 800);
  say(daemonUp, `emunet service: ${daemonUp ? 'running' : 'NOT RUNNING'}${!daemonUp && macDnsOnEmunet ? ' — the Mac\'s DNS points at it, so nothing resolves' : ''}`);
  if (!daemonUp) {
    problems += 1;
    if (fix) {
      doing('starting the service');
      daemonUp = await startDaemon();
      if (daemonUp) fixed += 1;
      else if (macDnsOnEmunet) {
        doing('service did not start; switching the Mac\'s DNS back to automatic so the internet works');
        if (await setMacDns(false)) fixed += 1;
      }
    }
  }

  // 2b. emunet's DNS forwarder and the mac-dns watchdog
  if (daemonUp) {
    const answering = await emunetDnsAnswering();
    let owner = '';
    if (!answering) {
      const out = await sh('/usr/sbin/lsof', ['+c', '0', '-nP', '-iUDP:' + state.dnsPort]).catch(() => '');
      owner = out.split('\n')[1]?.trim().split(/\s+/)[0] || '';
    }
    say(answering, `emunet DNS on 127.0.0.1:${state.dnsPort}: ${answering ? 'answering' : `NOT ANSWERING${owner ? ` (port held by ${owner})` : ''}`}`);
    if (!answering) {
      problems += 1;
      if (macDnsOnEmunet && fix) {
        doing('the Mac\'s DNS points at emunet but it cannot answer; restoring the previous DNS setting');
        if (await setMacDns(false)) fixed += 1;
      } else if (!macDnsOnEmunet) {
        console.log('  Emulator DNS (-dns-server 127.0.0.1) will not work and `emunet mac-dns on` is refused until this is solved.');
      }
    }
  }
  if (macDnsOnEmunet && managedNetwork.detected) {
    problems += 1;
    say(false, 'The Mac\'s DNS points at emunet, but this Mac is under managed network security.');
    if (fix) {
      doing('restoring the previous DNS setting to comply with company policy');
      if (await setMacDns(false)) fixed += 1;
    }
  } else if (macDnsOnEmunet) {
    const guarded = await guardLoaded();
    say(guarded, `mac-dns watchdog: ${guarded ? 'active' : 'MISSING — if emunet stops, the Mac has no DNS'}`);
    if (!guarded) {
      problems += 1;
      if (fix) {
        await installGuard(Object.keys(state.macDns || {}).length ? state.macDns : { [service.name]: ['Empty'] });
        doing('watchdog installed');
        fixed += 1;
      }
    }
  }

  // 3. Mac DNS
  await refreshDnsUpstreams().catch(() => {});
  const vpn = vpnInterfaces();
  const resolver = await systemResolver();
  let sysDns = await systemDnsWorks();
  say(sysDns, `Mac DNS (what apps use): ${sysDns ? 'working' : 'BROKEN'}  [${resolver.servers.join(', ') || (macDnsOnEmunet ? '127.0.0.1' : '?')}${resolver.ifName ? ` @${resolver.ifName}` : ''}]`);
  if (!sysDns) {
    problems += 1;
    const direct = await directDnsWorks();
    const routes = await Promise.all(resolver.servers.map(async (ip) => [ip, await routeInterface(ip)]));
    const viaTunnel = routes.filter(([, iface]) => isTunnelInterface(iface)).map(([ip]) => ip);
    const stale = resolver.servers.filter((ip) => !dnsModel.dhcp.includes(ip));
    let reason;
    if (!vpn.length && dnsModel.dhcp.length && resolver.servers.length && stale.length === resolver.servers.length) {
      reason = 'the VPN disconnected but its DNS servers were left behind (the VPN client did not restore them)';
    } else if (viaTunnel.length && resolver.ifName && !isTunnelInterface(resolver.ifName)) {
      reason = `the VPN's DNS (${viaTunnel.join(', ')}) is bound to ${resolver.ifName}, so queries leave outside the tunnel and are lost`;
    } else if (vpn.length) {
      reason = 'the DNS servers are unreachable while the VPN is up';
    } else {
      reason = 'the configured DNS servers do not answer';
    }
    console.log(`  Cause: ${reason}. Direct DNS (1.1.1.1 / 8.8.8.8): ${direct ? 'works' : 'also failing'}.`);
    if (managedNetwork.detected) {
      console.log(`  ${policyMessage()}`);
    } else if (fix && daemonUp && !(await emunetDnsAnswering())) {
      doing('cannot point the Mac\'s DNS at emunet: its DNS forwarder is not answering (see above)');
    } else if (fix && daemonUp) {
      doing('pointing the Mac\'s DNS at emunet (127.0.0.1); it picks the right server whether the VPN is up or not');
      if (!(await setMacDns(true))) {
        if (macDnsError) console.log(`  ${macDnsError}`);
      } else {
        sysDns = await systemDnsWorks();
        say(sysDns, `Mac DNS after fix: ${sysDns ? 'working' : 'still broken'}`);
        if (sysDns) fixed += 1;
      }
    }
  } else if (!macDnsOnEmunet && vpn.length && !managedNetwork.detected) {
    say(null, 'Mac DNS works now but is unprotected: VPN + proxy changes can break it. Permanent fix: emunet mac-dns on');
  }

  // 4. System proxy
  const proxyInfo = await proxySettings();
  const proxy = proxyInfo.proxy;
  if (proxyInfo.pac) {
    say(null, `Proxy auto-config (PAC) is set: ${proxyInfo.pac}. emunet does not evaluate PAC files; if emulators must use that proxy, run: emunet upstream host:port`);
  }
  if (proxyInfo.autoDiscovery) {
    say(null, 'Proxy auto-discovery (WPAD) is on. emunet does not use it; set `emunet upstream host:port` if your network needs a proxy.');
  }
  if (proxy) {
    const listening = await probeTcp(proxy.host, proxy.port, 800);
    const works = listening && (await proxyConnectWorks(proxy.host, proxy.port));
    const owner = listening ? (await listeningProcesses()).find((l) => l.port === proxy.port) : null;
    const label = `${proxy.host}:${proxy.port}${owner ? ` (${toolNameFor(owner) || owner.command})` : ''}`;
    say(works, `System proxy ${label}: ${works ? 'working' : listening ? 'listening but not passing traffic' : 'DEAD — browsers cannot load anything'}`);
    if (!works) {
      problems += 1;
      if (fix && managedNetwork.detected) {
        console.log(`  ${policyMessage()}`);
      } else if (fix) {
        doing('turning the system proxy off (your proxy tool turns it back on when it starts)');
        if (await setSystemProxyOff()) fixed += 1;
      }
    }
  } else if (!proxyInfo.pac) {
    say(true, 'System proxy: off (direct)');
  }

  // 5. Upstream used for emulator traffic
  if (daemonUp) {
    const upstream = await activeUpstream();
    say(true, `Emulator traffic goes through: ${describeUpstream(upstream)}`);
  }

  // 6. Emulators
  const procs = await emulatorProcesses();
  const emulatorSerials = process.env.EMUNET_NO_EMULATORS === '1' ? [] : await listEmulators();
  for (const serial of emulatorSerials) {
    const avdName = await emulatorAvdName(serial);
    const proc = procs.find((p) => p.avd === avdName) || null;
    const wanted = `10.0.2.2:${state.proxyPort}`;
    const httpProxy = await adb(serial, 'shell', 'settings', 'get', 'global', 'http_proxy').catch(() => null);
    const proxyOk = httpProxy === wanted;
    say(proxyOk, `${serial}: proxy ${httpProxy || '(none)'}${proxyOk ? '' : ` (expected ${wanted})`}`);
    if (!proxyOk) {
      problems += 1;
      if (fix) {
        await adb(serial, 'shell', 'settings', 'put', 'global', 'http_proxy', wanted);
        saveState({ manageEmulators: true });
        doing(`proxy set to ${wanted}`);
        fixed += 1;
      }
    }
    const resolves = await emulatorResolves(serial);
    say(resolves, `${serial}: DNS ${resolves ? 'working' : 'BROKEN'}${proc ? `  (started with -dns-server ${proc.dnsServer || 'none'})` : ''}`);
    if (proc && !proc.dnsOk) {
      if (resolves) say(null, `${serial}: DNS works now but is ${proc.dnsServer ? `pinned to ${proc.dnsServer}` : 'tied to the Mac\'s DNS at boot time'}; it breaks when the network/VPN changes.`);
      else problems += 1;
      if (fix && proc.avd && (yes || (await ask(`  Restart ${proc.avd} with emunet DNS? (running apps will close)`)))) {
        await cmdEmulator(proc.avd, true);
        if (!resolves) fixed += 1;
        continue;
      } else if (fix && !resolves) {
        doing(`skipped — run: emunet emulator ${proc.avd} --restart`);
      }
    }
    const validated = await wifiValidated(serial).catch(() => null);
    say(validated !== false, `${serial}: Android network validation ${validated === null ? 'unknown' : validated ? 'OK' : 'FAILED ("!" on Wi-Fi)'}`);
    if (validated === false) {
      problems += 1;
      if (fix) {
        await kickWifi(serial, 'emunet fix');
        doing('Wi-Fi restarted');
        fixed += 1;
      }
    }
  }

  // 7. iOS Simulator (shares the Mac's network stack)
  const sims = await bootedSimulators();
  if (sims.length) {
    say(null, `iOS Simulator: ${sims.join(', ')} — uses the Mac's network, so the Mac DNS / proxy checks above cover it.`);
    const owner = proxy ? (await listeningProcesses()).find((l) => l.port === proxy.port) : null;
    const tool = owner && toolNameFor(owner);
    if (tool) {
      say(null, `iOS Simulator traffic goes through ${tool} (system proxy): apps that pin TLS certificates will fail unless SSL proxying is disabled for their domains in ${tool}.`);
    }
  }

  console.log('');
  if (!problems) console.log('No problems found.');
  else if (!fix) console.log(`${problems} problem(s) found. To repair: emunet fix`);
  else console.log(`Fixed ${fixed} of ${problems} problem(s).${fixed < problems ? ' See the notes above for the rest.' : ''}`);
  if (problems > fixed) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function runDaemon() {
  const server = http.createServer(handleRequest);
  server.on('connect', handleConnect);
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('error', (error) => {
    log(`cannot listen on 127.0.0.1:${state.proxyPort} (${error.code || error.message}); exiting so launchd retries`);
    process.exit(1);
  });
  server.listen(state.proxyPort, '127.0.0.1', () => {
    log(`emunet ${VERSION} proxy on 127.0.0.1:${state.proxyPort} (upstream: ${state.upstream})`);
  });
  startDns();
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    await superviseTick().catch((error) => log(`supervisor: ${error.message}`));
    running = false;
  };
  tick();
  setInterval(tick, 5000);
  process.on('uncaughtException', (error) => log('uncaughtException:', error.stack || error.message));
}

async function cmdStatus() {
  let status;
  try {
    status = await fetchStatus();
  } catch {
    console.log(`emunet is not running (127.0.0.1:${state.proxyPort}). Start it: emunet service install`);
    process.exitCode = 1;
    return;
  }
  const yesNo = (value) => (value === null ? 'unknown' : value ? 'yes' : 'NO');
  console.log(`emunet ${status.version}  proxy ${status.proxy}`);
  console.log(`Upstream proxy (${status.upstreamSetting}): ${describeUpstream(status.upstream)}`);
  console.log(`VPN: ${status.vpn.length ? status.vpn.join(', ') : 'not connected'}`);
  const macOn = status.mac?.dnsServers.includes('127.0.0.1');
  console.log(`Mac DNS (${status.mac?.name || '?'}): ${macOn ? 'emunet (127.0.0.1) — protected' : `${status.mac?.dnsServers.join(', ') || 'automatic'} — unprotected (emunet mac-dns on)`}`);
  if (status.managedNetwork.length) console.log(`Managed network security: ${status.managedNetwork.join(', ')} (emunet leaves Mac settings alone; emulator DNS uses the system resolver)`);
  if (macOn) console.log(`mac-dns watchdog: ${status.dnsGuard ? 'active' : 'MISSING (run emunet fix)'}`);
  console.log(`DNS server order: ${status.dnsServers.join(' → ')}${status.vpnDns.length ? `  (VPN DNS: ${status.vpnDns.join(', ')})` : ''}`);
  for (const emulator of status.emulators) {
    console.log(`${emulator.serial}: http_proxy=${emulator.httpProxy}  validated=${yesNo(emulator.wifiValidated)}`);
  }
  for (const proc of status.emulatorProcesses) {
    const hint = proc.dnsOk ? '' : `  ← run: emunet emulator ${proc.avd} --restart`;
    console.log(`  AVD ${proc.avd} (pid ${proc.pid}) dns-server=${proc.dnsServer || '(none)'}${hint}`);
  }
  if (!status.emulators.length) console.log('No emulators connected.');
  console.log(`stats: ${JSON.stringify(status.stats)}`);
}

async function cmdOff() {
  saveState({ manageEmulators: false });
  for (const serial of await listEmulators()) {
    await adb(serial, 'shell', 'settings', 'put', 'global', 'http_proxy', ':0');
    console.log(`${serial}: proxy removed`);
  }
  console.log('Emulator management is off. Turn it back on with: emunet on');
}

async function cmdEmulator(avd, restart) {
  if (!avd) {
    console.error('Usage: emunet emulator <AVD name> [--restart]');
    process.exitCode = 1;
    return;
  }
  const running = (await emulatorProcesses()).filter((proc) => proc.avd === avd);
  if (running.length && !restart) {
    console.error(`${avd} is already running (pid ${running.map((p) => p.pid).join(',')}). Add --restart to restart it.`);
    process.exitCode = 1;
    return;
  }
  for (const proc of running) {
    console.log(`Stopping ${avd} (pid ${proc.pid})…`);
    process.kill(proc.pid, 'SIGTERM');
    for (let i = 0; i < 30 && (await emulatorProcesses()).some((p) => p.pid === proc.pid); i += 1) await sleep(1000);
  }
  const avdDir = path.join(os.homedir(), '.android', 'avd', `${avd}.avd`);
  for (const lock of ['multiinstance.lock', 'hardware-qemu.ini.lock']) {
    fs.rmSync(path.join(avdDir, lock), { force: true, recursive: true });
  }
  // -no-snapshot-load is required: a snapshot boot restores the old DNS configuration.
  const args = ['-avd', avd, '-no-snapshot-load', '-dns-server', '127.0.0.1'];
  spawn(findEmulator(), args, { detached: true, stdio: 'ignore' }).unref();
  console.log(`Started: emulator ${args.join(' ')}`);
  console.log('emunet sets its proxy automatically once it boots (within ~5 s).');
}

async function cmdUpstream(value) {
  if (!value) {
    const upstream = await detectUpstream();
    console.log(`setting: ${state.upstream}`);
    console.log(`detected: ${describeUpstream(upstream)}${upstream ? ` (via ${upstream.source})` : ''}`);
    return;
  }
  if (!['auto', 'none'].includes(value) && !/^[\w.-]+:\d+$/.test(value)) {
    console.error('Usage: emunet upstream [auto | none | host:port]');
    process.exitCode = 1;
    return;
  }
  saveState({ upstream: value });
  console.log(`upstream = ${value} (the service applies it within 5 s)`);
}

async function cmdMacDns(value) {
  if (!['on', 'off'].includes(value)) {
    console.error('Usage: emunet mac-dns on|off');
    process.exitCode = 1;
    return;
  }
  if (value === 'on') {
    await refreshManagedNetwork(true);
    if (managedNetwork.detected) {
      console.error(policyMessage());
      process.exitCode = 2;
      return;
    }
    if (!(await emunetDnsAnswering())) {
      console.error(`emunet is not answering DNS on 127.0.0.1:${state.dnsPort} (service stopped, or another program holds the port). `
        + 'Not changing the Mac\'s DNS, otherwise it would have none. Run: emunet doctor');
      process.exitCode = 1;
      return;
    }
  }
  const restoring = macDnsSummary();
  const ok = await setMacDns(value === 'on');
  if (ok && value === 'on') {
    console.log('Mac DNS → 127.0.0.1 (emunet). A watchdog restores the previous setting if emunet ever stops answering.');
  } else if (ok) {
    console.log(`Mac DNS → ${restoring} (restored)`);
  } else {
    console.error(macDnsError || 'Could not change the DNS setting.');
    process.exitCode = 1;
  }
}

const HELP = `emunet ${VERSION} — keep Android emulator and macOS internet working across VPN and proxy changes

  emunet fix [--yes]                 detect and repair internet problems (Mac + emulators)
  emunet doctor                      diagnose only; changes nothing
  emunet status                      show what emunet is doing
  emunet service install|uninstall   run emunet in the background at login / remove it
  emunet mac-dns on|off              point the Mac's DNS at emunet (survives broken VPN DNS) / undo
  emunet upstream [auto|none|h:p]    debugging proxy to chain through (auto-detects Proxyman,
                                     Charles, mitmproxy, Burp, Fiddler, HTTP Toolkit, Requestly, Whistle)
  emunet emulator <avd> [--restart]  (re)start an emulator using emunet DNS
  emunet off | on                    stop / resume managing emulator proxy settings
  emunet daemon                      run the service in the foreground (brew services uses this)`;

async function main(argv) {
  const [command = 'help', ...rest] = argv;
  switch (command) {
    case 'daemon':
      runDaemon();
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'doctor':
      await cmdDoctor({ fix: false });
      break;
    case 'fix':
      await cmdDoctor({ fix: true, yes: rest.includes('--yes') || rest.includes('-y') });
      break;
    case 'mac-dns':
      await cmdMacDns(rest[0]);
      break;
    case 'upstream':
      await cmdUpstream(rest[0]);
      break;
    case 'service':
      await cmdService(rest[0]);
      break;
    case 'on':
      saveState({ manageEmulators: true });
      console.log('Emulator management is on.');
      break;
    case 'off':
      await cmdOff();
      break;
    case 'emulator':
      await cmdEmulator(rest.find((arg) => !arg.startsWith('-')), rest.includes('--restart'));
      break;
    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION);
      break;
    default:
      console.log(HELP);
  }
}

// Run as a CLI; stay quiet when imported (tests).
const invoked = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));

export { main, refreshDnsUpstreams, resolveViaSystem, answerQuery, emunetDnsAnswering, setMacDns, refreshManagedNetwork };
export function setDnsModelForTest(model) {
  dnsModel = { supplemental: [], defaults: [], dhcp: [], vpn: [], ...model, updatedAt: Date.now() };
}
export function setManagedForTest(agents) {
  managedNetwork = { detected: agents.length > 0, agents, at: Date.now() };
}
