# Changelog

## 0.6.1
- Fix: with `mac-dns on` and a VPN client that does not publish its DNS (Tunnelblick), names under the
  VPN's domains were sent to the local network's DNS; routers that answer unknown names with their own
  address then received company traffic (seen as TLS errors on `git push`). While a VPN is up, VPN
  names now go only to the VPN's DNS, and fail instead of falling back.
- emunet remembers VPN DNS per domain (`emunet vpn-dns list|add|remove`) and reuses it only while the
  servers are routed through the tunnel.
- `doctor` reports a connected VPN whose DNS is unknown; `mac-dns on` is refused in that state.

## 0.6.0
- `emunet emulator-args` and `import { emulatorArgs } from 'emunet'`: the emulator flags
  (`-no-snapshot-load -dns-server 127.0.0.1`) for your own scripts, CI and Node tools — empty when
  emunet is not running, so they are safe to use unconditionally.

## 0.5.1
- Privacy: names under the VPN's domains or a per-domain resolver are never sent to public resolvers,
  even when every other DNS server is down.
- Security: the local status page only answers requests addressed to 127.0.0.1 / localhost, so a web
  page using DNS rebinding cannot read your VPN DNS servers or domains.

## 0.5.0
- New install options besides Homebrew: a one-line `curl … | bash` installer and `npm install -g emunet`.
- `emunet service install|uninstall|status` sets up / removes the login service (LaunchAgent, or
  `brew services` for Homebrew installs). Uninstalling restores the Mac's DNS first.
- DNS forwarder follows macOS's plan: per-domain resolvers only get their domains (no more sending
  every query to the VPN or Tailscale DNS); servers that time out, REFUSE or SERVFAIL are skipped;
  split-horizon VPN NXDOMAINs for public names are re-checked with the network DNS; the VPN's own
  domains and nonexistent names never leak to public resolvers or get hijacked by routers.
- Company-managed Macs: detects Zscaler, Cisco Umbrella / Secure Client, Netskope, Cloudflare WARP,
  GlobalProtect, Forcepoint, Jamf Trust and Check Point Harmony; then never changes Mac DNS / proxy
  settings and answers emulator DNS through the system resolver.
- `mac-dns` safety: refused unless emunet answers DNS and the account can change DNS without sudo;
  remembers the previous DNS (IPv4 + IPv6) per service and restores exactly that; a Node-independent
  watchdog (health name, not real DNS) restores it if emunet stops answering; settings enabled by
  older versions are adopted and the watchdog is kept up to date automatically.
- Robustness: exits on port conflicts so launchd retries; TCP DNS upstream hang-ups fall through;
  short/garbage packets, early client disconnects and malformed proxy URLs are handled.
- `doctor` / `fix`: PAC / WPAD notice, port-53 owner, watchdog check, iOS Simulator section.
- The service runs Node from a stable path, so Node upgrades do not break it.
- Test suite (`npm test`).

## 0.4.0
- English CLI, logs and docs.
- Works with any debugging proxy: follows the macOS system proxy, and otherwise auto-detects
  Proxyman, Charles, mitmproxy, Burp Suite, Fiddler Everywhere, HTTP Toolkit, Requestly and Whistle.
  A listening port is only used if it actually behaves like an HTTP proxy.
- `emunet upstream [auto|none|host:port]` replaces `emunet mode`; old settings are migrated.
- Homebrew formula template for GitHub releases (`scripts/release.sh`).

## 0.3.0
- `emunet doctor` and `emunet fix`: detect and repair broken Mac DNS (VPN DNS bound to the wrong
  interface, VPN DNS left behind after disconnect), dead system proxies, the emunet service itself,
  and emulator proxy / DNS / network-validation problems.

## 0.2.0
- DNS forwarder relays raw queries (VPN DNS → DHCP DNS → public) instead of asking the macOS
  resolver, so the Mac itself can use it (`emunet mac-dns on`).
- The proxy's direct connections resolve through the forwarder.

## 0.1.0
- Fixed emulator proxy that chains through a debugging proxy when it is up, direct otherwise.
- DNS for emulators started with `-dns-server 127.0.0.1`; emulator supervisor.
