# emunet

**Keep Android emulator and macOS internet working while VPNs and debugging proxies come and go.**

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
| `emunet upstream [auto\|none\|host:port]` | Which debugging proxy to chain emulator traffic through |
| `emunet emulator <avd> [--restart]` | (Re)start an emulator with emunet DNS |
| `emunet off` / `emunet on` | Stop / resume managing emulator proxy settings |

## What `emunet fix` checks

| Check | If broken, `fix` will |
|---|---|
| Raw connectivity (TCP to 1.1.1.1 / 8.8.8.8) | Stop and tell you the network itself is down |
| emunet service | Start it; if it won't start and the Mac's DNS points at it, switch the Mac's DNS back to automatic |
| Mac DNS (getaddrinfo, what apps use) | Explain the cause (VPN DNS bound to the wrong interface, VPN DNS left behind after disconnect, unreachable servers) and point the Mac's DNS at emunet |
| System proxy | Turn off a dead proxy, or one that accepts connections but passes no traffic |
| Each emulator | Fix its proxy setting, offer to restart it with emunet DNS if its DNS is pinned, re-run Android's network validation |

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
3. **A DNS forwarder on :53.** It relays raw queries to the VPN's DNS through the tunnel when a VPN
   is connected, then to the network's DHCP DNS, then to 1.1.1.1 / 8.8.8.8. It never asks the macOS
   resolver, so it keeps working when that is broken. Emulators started by emunet use it
   (`-dns-server 127.0.0.1`), and so does the Mac after `emunet mac-dns on`.
4. **A supervisor.** Every 5 seconds it re-applies the emulator proxy setting and, when Android
   marks the network as unvalidated after a VPN/proxy change, restarts the emulator's Wi-Fi.

### Why `mac-dns`?

Some VPN clients (OpenVPN Connect is one) write the VPN's DNS servers onto the Wi-Fi service
instead of the tunnel. When macOS later re-evaluates the network (a proxy tool toggling the
system proxy is enough), the resolver gets scoped to `en0` and mDNSResponder sends every query
out of Wi-Fi, outside the tunnel, where the VPN's DNS server can't be reached. Ping works and
nothing else does. In the office the VPN DNS may also be reachable over the LAN, so you only
see it at home or on a hotspot.

With `emunet mac-dns on` the Mac asks `127.0.0.1`, and emunet sends the query to the right
server according to the routing table. **If emunet is stopped while this is on, the Mac has no
DNS.** The service is kept alive by launchd, `emunet fix` detects it, and you should run
`emunet mac-dns off` before uninstalling.

## Use with Android Studio / scripts

Start emulators through emunet so their DNS survives network changes:

```bash
emunet emulator Pixel_8_API_35            # add --restart if it is already running
```

Your own scripts can do the same with `emulator -avd <name> -no-snapshot-load -dns-server 127.0.0.1`.
(`-no-snapshot-load` matters: a snapshot boot restores the old DNS configuration.)

## Configuration

`~/.config/emunet/state.json`: `proxyPort` (8877), `dnsPort` (53), `upstream` (`auto`),
`manageEmulators` (`true`). Logs: `~/Library/Logs/emunet.log` (Homebrew: `$(brew --prefix)/var/log/emunet.log`).

## Limitations

- macOS only. Android **emulators** only; physical devices and Genymotion are left alone.
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
scripts/install-local.sh          # run this checkout as a LaunchAgent
scripts/install-local.sh --brew   # or through a local Homebrew tap
scripts/release.sh <owner> <tap>  # render the formula for a tagged GitHub release
```

## License

MIT
