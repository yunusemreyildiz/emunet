<p align="center">
  <img src="https://raw.githubusercontent.com/yunusemreyildiz/emunet/main/assets/logo.svg" width="128" alt="emunet logo">
</p>

<h1 align="center">emunet</h1>

**Keep Android emulator, iOS Simulator and macOS internet working while VPNs and debugging proxies come and go.**

You connect to the company VPN and the emulator goes offline. You quit Proxyman and every app in the
emulator says "No internet". You disconnect the VPN and the Mac's browser can't load anything until
you reboot. `emunet` is a small background service for macOS that keeps all of that working, plus an
`emunet fix` command that finds out what broke and repairs it.

```console
$ emunet fix
✓ Internet (TCP to 1.1.1.1 / 8.8.8.8): reachable
✓ emunet service: running
✗ Mac DNS (what apps use): BROKEN  [10.20.0.53 @en0]
  Cause: the VPN's DNS (10.20.0.53) is bound to en0, so queries leave outside the tunnel and are lost.
  → pointing the Mac's DNS at emunet (127.0.0.1); it picks the right server whether the VPN is up or not
✓ Mac DNS after fix: working
✓ System proxy 127.0.0.1:9090 (Proxyman): working
✓ Emulator traffic goes through: Proxyman 127.0.0.1:9090
✗ emulator-5554: Android network validation FAILED ("!" on Wi-Fi)
  → Wi-Fi restarted

Fixed 2 of 2 problem(s).
```

## Install

Pick one. All three end with the same `emunet` command and a background service that starts at login.

**Homebrew**

```bash
brew install yunusemreyildiz/tap/emunet
brew services start emunet
```

**One-line installer** (no Homebrew; needs Node.js 18+)

```bash
curl -fsSL https://raw.githubusercontent.com/yunusemreyildiz/emunet/main/install.sh | bash
```

It downloads `emunet.mjs` from the latest GitHub release into `~/Library/Application Support/emunet`,
links the `emunet` command and starts the service as a LaunchAgent in your account. No sudo.
Prefer to read it first? `curl -fsSLO https://raw.githubusercontent.com/yunusemreyildiz/emunet/main/install.sh`,
then `bash install.sh`.

**npm** (needs Node.js 18+)

```bash
npm install -g emunet
emunet service install
```

Android SDK platform-tools (`adb`) are needed for the emulator features.

## Usage

| Command | What it does |
|---|---|
| `emunet fix [--yes]` | Diagnose and repair (asks before disruptive steps such as restarting an emulator; `--yes` skips the questions) |
| `emunet doctor` | Diagnose only, changes nothing |
| `emunet status` | What emunet is doing right now |
| `emunet service install\|uninstall\|status` | Run emunet in the background at login (LaunchAgent, or `brew services` for Homebrew installs) |
| `emunet mac-dns on\|off` | Point the Mac's own DNS at emunet so broken VPN DNS can't take the whole Mac down (see below) |
| `emunet vpn-dns [list\|add\|remove]` | VPN DNS emunet remembers, for VPN clients that hide it (see below) |
| `emunet upstream [auto\|none\|host:port]` | Which debugging proxy to chain emulator traffic through |
| `emunet emulator <avd> [--restart]` | (Re)start an emulator with emunet DNS |
| `emunet emulator-args` | The emulator flags for your own scripts (empty when emunet is not running) |
| `emunet off` / `emunet on` | Stop / resume managing emulator proxy settings |

## What `emunet fix` checks

| Check | If broken, `fix` will |
|---|---|
| Raw connectivity (TCP to 1.1.1.1 / 8.8.8.8) | Stop and tell you the network itself is down |
| emunet service | Start it; if it won't start and the Mac's DNS points at it, switch the Mac's DNS back to automatic |
| Mac DNS (getaddrinfo, what apps use) | Explain the cause (VPN DNS bound to the wrong interface, VPN DNS left behind after disconnect, unreachable servers) and point the Mac's DNS at emunet |
| System proxy | Turn off a dead proxy, or one that accepts connections but passes no traffic |
| emunet's DNS forwarder | Report another program holding port 53; if the Mac's DNS points at emunet but it cannot answer, restore the previous DNS |
| mac-dns watchdog | Reinstall it if `mac-dns` is on but the watchdog is missing |
| Proxy auto-config (PAC / WPAD) | Tell you, since emunet does not evaluate PAC files |
| Each Android emulator | Fix its proxy setting, offer to restart it with emunet DNS if its DNS is pinned, re-run Android's network validation |
| iOS Simulator | Nothing extra to fix (it shares the Mac's network); warns when a debugging proxy will break certificate-pinned apps |
| Company security software | Never changes Mac settings; if `mac-dns` was on, switches it back (see below) |

Changes to macOS network settings are made with `networksetup`; if that needs admin rights you are
asked for your password via `sudo`.

## How it works

1. **A fixed proxy for emulators: `127.0.0.1:8877`.** Emulators always use `10.0.2.2:8877`, so their
   setting never has to change. emunet chains the traffic through your debugging proxy when one is
   running and goes direct when it isn't. If the proxy dies mid-session, new connections fall back to direct.
2. **Debugging proxy detection (`upstream auto`).** First the macOS system proxy (Proxyman, Charles and
   Fiddler set it), then known tools that are listening: Proxyman, Charles, mitmproxy, Burp Suite,
   Fiddler Everywhere, HTTP Toolkit, Requestly, Whistle. A non-default port is only used if it answers
   like an HTTP proxy, so a random dev server is never picked by mistake. Use `emunet upstream host:port`
   for anything else, or `emunet upstream none` to always go direct.
3. **A DNS forwarder on :53.** It never asks the macOS resolver, so it keeps working when that is
   broken. Emulators started by emunet use it (`-dns-server 127.0.0.1`), and so does the Mac after
   `emunet mac-dns on`. For each query it follows the same plan macOS would:
   - names under a per-domain resolver (VPN match domains, `/etc/resolver/*`, Tailscale…) go only to
     that resolver — public names are never sent there;
   - everything else goes to the default resolvers (the VPN's DNS first when the VPN set one), then
     the network's own DHCP DNS, then 1.1.1.1 / 8.8.8.8 as a last resort;
   - a server that times out, refuses or SERVFAILs is skipped; an NXDOMAIN from a split-horizon VPN DNS
     for a public name is double-checked with the network DNS, but an NXDOMAIN for the VPN's own
     domains is final, and nonexistent names are never sent to public resolvers.
4. **A supervisor.** Every 5 seconds it re-applies the emulator proxy setting and, when Android
   marks the network as unvalidated after a VPN/proxy change, restarts the emulator's Wi-Fi.

### VPN clients that hide their DNS (Tunnelblick)

With `mac-dns on` the Mac's DNS is set manually, and some VPN clients — Tunnelblick by default — then
leave it alone: they add their search domain but publish their DNS servers nowhere. emunet handles it:

- While a VPN is up, names under the VPN's domains go **only** to the VPN's DNS. If that DNS is unknown
  they fail (SERVFAIL) instead of being asked to your router — many routers answer unknown names with
  their own address, which sends company traffic (git, HTTPS) to the router.
- emunet remembers the VPN DNS whenever it can see it and reuses it later, but only while those servers
  are actually routed through the tunnel.
- `emunet doctor` reports "VPN is connected but its DNS servers are unknown" (also when Tunnelblick kept
  the manual DNS without adding a search domain) and checks that remembered servers still answer;
  `mac-dns on` is refused in that state. VPNs that publish DNS per domain (Tailscale, WireGuard) are fine. To teach emunet: reconnect the VPN once with `mac-dns off`, or add it yourself:

```bash
emunet vpn-dns add corp.example 10.20.0.53 10.20.0.54
```

### iOS Simulator

The Simulator has no network stack of its own; it uses the Mac's DNS and system proxy. Everything
`emunet fix` repairs on the Mac (DNS, dead system proxy) fixes the Simulator too. One thing emunet
cannot fix: apps that pin TLS certificates fail through a debugging proxy (`doctor` tells you when
that applies) — disable SSL proxying for their domains in your proxy tool.

### Company-managed Macs

If emunet finds network security software (Zscaler, Cisco Umbrella / Secure Client, Netskope,
Cloudflare WARP / Zero Trust, Palo Alto GlobalProtect, Forcepoint, Jamf Trust, Check Point Harmony),
it will not change the Mac's DNS or proxy settings:

```console
$ emunet mac-dns on
Your organization manages this Mac's network security with Zscaler. emunet will not change the
Mac's DNS or proxy settings. Ask your IT team if you need a change.
```

Emulator features keep working, and emulator DNS is answered through the system resolver so the
company's DNS policy still applies.

### Do I need `mac-dns`?

Only if connecting your VPN breaks the **Mac's own** internet (ping works, no site loads). Emulator
features never need it. It is off by default; leave it off when the VPN does not cause trouble.

### Why `mac-dns`?

Some VPN clients (OpenVPN Connect is one) write the VPN's DNS servers onto the Wi-Fi service
instead of the tunnel. When macOS later re-evaluates the network (a proxy tool toggling the
system proxy is enough), the resolver gets scoped to `en0` and mDNSResponder sends every query
out of Wi-Fi, outside the tunnel, where the VPN's DNS server can't be reached. Ping works and
nothing else does. In the office the VPN DNS may also be reachable over the LAN, so you only
see it at home or on a hotspot.

With `emunet mac-dns on` the Mac asks `127.0.0.1`, and emunet sends the query to the right
server according to the routing table. Safety nets:

- `mac-dns on` is refused unless emunet is actually answering DNS on 127.0.0.1:53, and on accounts
  that cannot change DNS without an administrator password (the watchdog could not undo it).
- The previous DNS setting (IPv4 and IPv6) is remembered per network service; `mac-dns off` and
  `emunet service uninstall` restore exactly the services emunet changed, and leave a service alone
  if you changed it yourself in the meantime.
- A small watchdog (`local.emunet.dnsguard`, plain `/bin/sh`, no Node) checks every 20 s by asking
  emunet a name only emunet answers, so slow or broken upstream DNS never triggers it. If emunet does
  not answer twice in a row — crashed, deleted, another program took the port — it puts the previous
  DNS back and logs it to `~/Library/Logs/emunet.log`. It removes itself once emunet is uninstalled.
- If emunet cannot bind its ports it exits, so launchd retries instead of keeping a service that does nothing.

## Use from your scripts, CI and Node projects

The DNS flag only works when an emulator boots, so start emulators with it. emunet hands you the
right flags, and nothing when it is not running — safe to use everywhere:

```bash
emulator -avd Pixel_8_API_35 $(emunet emulator-args)     # → -no-snapshot-load -dns-server 127.0.0.1
emunet emulator Pixel_8_API_35 [--restart]                # or let emunet start it
```

From Node (`npm install emunet`):

```js
import { spawn } from 'node:child_process';
import { emulatorArgs } from 'emunet';

spawn('emulator', ['-avd', 'Pixel_8_API_35', ...await emulatorArgs()], { detached: true, stdio: 'ignore' });
```

`emulatorArgs({ coldBoot: false })` / `emunet emulator-args --keep-snapshot` leave out
`-no-snapshot-load` (faster boot, but a snapshot boot restores the old DNS settings).

Emulators started from Android Studio don't get the flag; their app traffic still goes through
emunet's proxy, and `emunet fix` offers to restart them with emunet DNS.

## Configuration

`~/.config/emunet/state.json`: `proxyPort` (8877), `dnsPort` (53), `upstream` (`auto`),
`manageEmulators` (`true`). Logs: `~/Library/Logs/emunet.log` (Homebrew: `$(brew --prefix)/var/log/emunet.log`).

## When not to use emunet

- **Your Mac is managed by IT** and DNS / web security is enforced: emunet detects the common agents and
  stays out of the way, but if yours is not on the list, do not run `emunet mac-dns on`.
- **Your network needs a PAC file or an authenticating proxy** for emulator traffic: set it with
  `emunet upstream host:port` (emunet does not evaluate PAC or send proxy credentials).
- **Something else already serves DNS on port 53** (dnsmasq, a local Pi-hole, some Docker setups): the
  emulator DNS and `mac-dns` features are unavailable; `emunet doctor` shows which program holds the port.
- **You need Windows or Linux**: not supported (yet).

## Limitations

- macOS only. Android **emulators** and the iOS Simulator; physical devices and Genymotion are left alone.
- Emulators launched from Android Studio do not get `-dns-server 127.0.0.1`. Their app traffic still goes
  through emunet's proxy (which resolves names on the Mac), but for full DNS protection start them with
  `emunet emulator <avd>`.
- Captive portals (hotel / café Wi-Fi sign-in pages) and IPv6-only networks are not handled.
- The DNS forwarder listens on `0.0.0.0:53` (macOS only lets non-root processes bind port 53 that
  way) and ignores every client that is not on the loopback interface.
- Lookups made by emunet's own proxy use IPv4 (A records).

## Uninstall

```bash
emunet off                      # stop managing emulator proxies
emunet service uninstall        # also switches the Mac's DNS back to automatic if mac-dns was on
```

then remove the command the way you installed it: `brew uninstall emunet`,
`curl -fsSL https://raw.githubusercontent.com/yunusemreyildiz/emunet/main/install.sh | bash -s -- --uninstall`,
or `npm uninstall -g emunet`.

## Development

```bash
npm test                          # 51 tests; isolated config, dry-run, fake DNS servers — no system changes
scripts/install-local.sh          # run this checkout as a LaunchAgent
scripts/install-local.sh --brew   # or through a local Homebrew tap
scripts/release.sh <owner> <tap>  # render the formula for a tagged GitHub release
```

## License

MIT
