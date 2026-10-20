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

const execFileAsync = promisify(execFile);
const VERSION = '0.5.0';

// getaddrinfo runs on libuv's thread pool; a hung VPN resolver must not starve the proxy.
process.env.UV_THREADPOOL_SIZE ||= '16';

const SERVICE_LABEL = 'local.emunet';
const SERVICE_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
const SERVICE_LOG = path.join(os.homedir(), 'Library', 'Logs', 'emunet.log');

const CONFIG_DIR = path.join(os.homedir(), '.config', 'emunet');
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

async function systemProxy() {
  const out = await sh('/usr/sbin/scutil', ['--proxy']).catch(() => '');
  for (const kind of ['HTTPS', 'HTTP']) {
    if (new RegExp(`${kind}Enable : 1`).test(out)) {
      const host = new RegExp(`${kind}Proxy : (\\S+)`).exec(out)?.[1];
      const port = Number(new RegExp(`${kind}Port : (\\d+)`).exec(out)?.[1]);
      if (host && port) return { host, port };
    }
  }
  return null;
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
  const target = new URL(req.url);
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

const PUBLIC_DNS = ['1.1.1.1', '8.8.8.8'];
let dnsUpstreams = { vpn: [], dhcp: [], updatedAt: 0 };

async function refreshDnsUpstreams() {
  // With the Mac's DNS pointed at 127.0.0.1, `scutil --dns` no longer lists the VPN servers,
  // so also read the per-service State:/Network/Service/*/DNS keys VPN clients write.
  const store = await sh('/usr/sbin/scutil', ['--dns']).catch(() => '');
  const keys = (await scutilRun('list State:/Network/Service/[^/]+/DNS\n')).match(/State:\/Network\/Service\/\S+\/DNS/g) || [];
  let serviceDns = '';
  for (const key of keys) serviceDns += await scutilShow(key);
  const configured = ipv4List([...store.split('\n').filter((line) => line.includes('nameserver')), serviceDns].join(' '));
  const vpn = [];
  for (const ip of configured) {
    if (isTunnelInterface(await routeInterface(ip))) vpn.push(ip);
  }
  const iface = /PrimaryInterface : (\S+)/.exec(await scutilShow('State:/Network/Global/IPv4'))?.[1] || 'en0';
  const dhcp = ipv4List(await sh('/usr/sbin/ipconfig', ['getoption', iface, 'domain_name_server']).catch(() => ''));
  // No DHCP DNS (static configuration etc.): use configured servers that are not behind the VPN.
  const others = configured.filter((ip) => !vpn.includes(ip));
  dnsUpstreams = { vpn, dhcp: dhcp.length ? dhcp : others, updatedAt: Date.now() };
}

function dnsServerOrder() {
  return [...new Set([...dnsUpstreams.vpn, ...dnsUpstreams.dhcp, ...PUBLIC_DNS])];
}

function forwardUdp(query, server, timeoutMs) {
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
    socket.send(query, 53, server);
  });
}

function forwardTcp(query, server, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: server, port: 53 });
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
  });
}

async function resolveRaw(query, transport) {
  for (const server of dnsServerOrder()) {
    try {
      const timeout = dnsUpstreams.vpn.includes(server) ? 2500 : 2000;
      return transport === 'tcp' ? await forwardTcp(query, server, timeout) : await forwardUdp(query, server, timeout);
    } catch {
      // try the next server
    }
  }
  throw new Error('no DNS server answered');
}

function buildQuery(name) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(Math.floor(Math.random() * 0xffff), 0);
  header.writeUInt16BE(0x0100, 2); // RD
  header.writeUInt16BE(1, 4);
  const labels = name.split('.').filter(Boolean).map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]));
  return Buffer.concat([header, ...labels, Buffer.from([0, 0, 1, 0, 1])]);
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

function parseARecords(msg) {
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

function startDns() {
  refreshDnsUpstreams().catch(() => {});
  const udp = dgram.createSocket('udp4');
  udp.on('error', (error) => {
    log(`DNS disabled: cannot listen on :${state.dnsPort} (${error.code || error.message})`);
    udp.close();
  });
  udp.on('message', async (msg, rinfo) => {
    // Bound to 0.0.0.0 (macOS only lets non-root processes bind :53 that way); never answer the LAN.
    if (!isLoopback(rinfo.address) || msg.length < 12) return;
    stats.dnsQueries += 1;
    let response;
    try {
      response = await resolveRaw(msg, 'udp');
    } catch {
      stats.dnsFail += 1;
      response = servfail(msg);
    }
    udp.send(response, rinfo.port, rinfo.address);
  });
  udp.bind(state.dnsPort, '0.0.0.0', () => log(`DNS forwarder listening on :${state.dnsPort} udp+tcp (loopback clients only)`));

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
        stats.dnsQueries += 1;
        let response;
        try {
          response = await resolveRaw(query, 'tcp');
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
  tcp.on('error', (error) => log(`DNS (tcp) disabled: ${error.code || error.message}`));
  tcp.listen(state.dnsPort, '0.0.0.0');
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
  const uuid = /PrimaryService : (\S+)/.exec(await scutilShow('State:/Network/Global/IPv4'))?.[1];
  if (!uuid) return null;
  const name = /UserDefinedName : (.+)/.exec(await scutilShow(`Setup:/Network/Service/${uuid}`))?.[1]?.trim();
  if (!name) return null;
  const current = await sh('/usr/sbin/networksetup', ['-getdnsservers', name]).catch(() => '');
  return { name, dnsServers: ipv4List(current).concat(current.includes('127.0.0.1') ? ['127.0.0.1'] : []) };
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
    vpnDns: dnsUpstreams.vpn,
    mac: await primaryService(),
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
  try {
    await execFileAsync(cmd, args, { timeout: 15000 });
    return true;
  } catch {
    console.log(`   needs admin rights: sudo ${path.basename(cmd)} ${args.join(' ')}`);
    return spawnSync('sudo', [cmd, ...args], { stdio: 'inherit' }).status === 0;
  }
}

async function setMacDns(on) {
  const service = await primaryService();
  if (!service) throw new Error('No primary network service found.');
  const ok = await privileged('/usr/sbin/networksetup', ['-setdnsservers', service.name, on ? '127.0.0.1' : 'Empty']);
  if (ok) await execFileAsync('/usr/bin/dscacheutil', ['-flushcache']).catch(() => {});
  return ok;
}

async function setSystemProxyOff() {
  const service = await primaryService();
  if (!service) return false;
  const http1 = await privileged('/usr/sbin/networksetup', ['-setwebproxystate', service.name, 'off']);
  const https1 = await privileged('/usr/sbin/networksetup', ['-setsecurewebproxystate', service.name, 'off']);
  return http1 && https1;
}

async function startDaemon() {
  if (isBrewInstall()) {
    await execFileAsync('brew', ['services', 'restart', 'emunet']).catch(() => {});
  } else if (fs.existsSync(SERVICE_PLIST)) {
    const uid = process.getuid();
    await execFileAsync('/bin/launchctl', ['bootstrap', `gui/${uid}`, SERVICE_PLIST]).catch(() => {});
    await execFileAsync('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/${SERVICE_LABEL}`]).catch(() => {});
  } else {
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
  return fs.realpathSync(process.argv[1]);
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
  return execFileAsync('/bin/launchctl', ['print', `gui/${process.getuid()}/${SERVICE_LABEL}`]).then(() => true, () => false);
}

async function bootoutAgent() {
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
  const service = await primaryService();
  if (service?.dnsServers.includes('127.0.0.1')) {
    console.log('The Mac\'s DNS points at emunet; switching it back to automatic first.');
    await setMacDns(false);
  }
  if (isBrewInstall()) {
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
    const stale = resolver.servers.filter((ip) => !dnsUpstreams.dhcp.includes(ip));
    let reason;
    if (!vpn.length && dnsUpstreams.dhcp.length && resolver.servers.length && stale.length === resolver.servers.length) {
      reason = 'the VPN disconnected but its DNS servers were left behind (the VPN client did not restore them)';
    } else if (viaTunnel.length && resolver.ifName && !isTunnelInterface(resolver.ifName)) {
      reason = `the VPN's DNS (${viaTunnel.join(', ')}) is bound to ${resolver.ifName}, so queries leave outside the tunnel and are lost`;
    } else if (vpn.length) {
      reason = 'the DNS servers are unreachable while the VPN is up';
    } else {
      reason = 'the configured DNS servers do not answer';
    }
    console.log(`  Cause: ${reason}. Direct DNS (1.1.1.1 / 8.8.8.8): ${direct ? 'works' : 'also failing'}.`);
    if (fix && daemonUp) {
      doing('pointing the Mac\'s DNS at emunet (127.0.0.1); it picks the right server whether the VPN is up or not');
      if (await setMacDns(true)) {
        sysDns = await systemDnsWorks();
        say(sysDns, `Mac DNS after fix: ${sysDns ? 'working' : 'still broken'}`);
        if (sysDns) fixed += 1;
      }
    }
  } else if (!macDnsOnEmunet && vpn.length) {
    say(null, 'Mac DNS works now but is unprotected: VPN + proxy changes can break it. Permanent fix: emunet mac-dns on');
  }

  // 4. System proxy
  const proxy = await systemProxy();
  if (proxy) {
    const listening = await probeTcp(proxy.host, proxy.port, 800);
    const works = listening && (await proxyConnectWorks(proxy.host, proxy.port));
    const owner = listening ? (await listeningProcesses()).find((l) => l.port === proxy.port) : null;
    const label = `${proxy.host}:${proxy.port}${owner ? ` (${toolNameFor(owner) || owner.command})` : ''}`;
    say(works, `System proxy ${label}: ${works ? 'working' : listening ? 'listening but not passing traffic' : 'DEAD — browsers cannot load anything'}`);
    if (!works) {
      problems += 1;
      if (fix) {
        doing('turning the system proxy off (your proxy tool turns it back on when it starts)');
        if (await setSystemProxyOff()) fixed += 1;
      }
    }
  } else {
    say(true, 'System proxy: off (direct)');
  }

  // 5. Upstream used for emulator traffic
  if (daemonUp) {
    const upstream = await activeUpstream();
    say(true, `Emulator traffic goes through: ${describeUpstream(upstream)}`);
  }

  // 6. Emulators
  const procs = await emulatorProcesses();
  for (const serial of await listEmulators()) {
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
  if (value === 'on' && !(await probeTcp('127.0.0.1', state.proxyPort, 800))) {
    console.error('The emunet service is not running; start it first (emunet fix), otherwise the Mac would have no DNS.');
    process.exitCode = 1;
    return;
  }
  const ok = await setMacDns(value === 'on');
  console.log(ok ? `Mac DNS → ${value === 'on' ? '127.0.0.1 (emunet)' : 'automatic (DHCP / VPN)'}` : 'Could not change the DNS setting.');
  if (!ok) process.exitCode = 1;
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

const [command = 'help', ...rest] = process.argv.slice(2);
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
