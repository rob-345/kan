import { BlockList, isIP } from "net";

// Addresses a link preview fetch must never connect to: loopback, private
// networks, link-local (cloud metadata endpoints), carrier-grade NAT,
// multicast, documentation and other reserved ranges. IPv4-mapped IPv6
// addresses (::ffff:a.b.c.d) are matched against the IPv4 rules by BlockList.
const blockedAddresses = new BlockList();

const IPV4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const IPV6_BLOCKED: [string, number][] = [
  ["::", 128],
  ["::1", 128],
  // IPv4-compatible (deprecated) addresses
  ["::", 96],
  // NAT64, 6to4 and Teredo can tunnel to arbitrary IPv4 addresses
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["2001::", 32],
  ["2002::", 16],
  ["2001:db8::", 32],
  ["100::", 64],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
];

for (const [network, prefix] of IPV4_BLOCKED) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of IPV6_BLOCKED) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
];

export const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);

/** True when an IP address is private, internal or otherwise not public. */
export const isBlockedAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) return blockedAddresses.check(address, "ipv4");
  if (family === 6) return blockedAddresses.check(address, "ipv6");
  // Anything that is not a valid IP address is treated as unsafe.
  return true;
};

/** True when a hostname is obviously internal before any DNS lookup. */
export const isBlockedHostname = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost") return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return true;
  }
  // Single-label hostnames (e.g. "postgres", "redis") only resolve on
  // internal networks.
  if (!host.includes(".") && !host.includes(":")) return true;

  const literal = host.startsWith("[") ? host.slice(1, -1) : host;
  if (isIP(literal)) return isBlockedAddress(literal);
  return false;
};
