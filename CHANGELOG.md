# Changelog

## 0.5.0
- New install options besides Homebrew: a one-line `curl … | bash` installer and `npm install -g emunet`.
- `emunet service install|uninstall|status` sets up / removes the login service (LaunchAgent, or
  `brew services` for Homebrew installs). Uninstalling turns `mac-dns` off first so the Mac keeps DNS.
- The service runs Node from a stable path, so Node upgrades do not break it.

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
