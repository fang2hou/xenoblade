/**
 * SSRF protection for outbound URL fetches.
 *
 * Cloudflare Workers cannot perform DNS resolution, so this is a string-based
 * check on the hostname: it rejects well-known private/reserved IP literals,
 * loopback, link-local ranges (including the Cloudflare metadata endpoint),
 * the literal "localhost", and non-http(s) schemes. DNS hostnames are allowed
 * — the model decides what to read, and the runtime cannot resolve them to
 * internal addresses anyway.
 */

/** Parse a dotted-quad IPv4 literal; returns null when the string is not one. */
function parseIPv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = [0, 0, 0, 0] as [number, number, number, number];
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    // Reject hex/octal encodings and non-numeric garbage so only plain decimal
    // quads are treated as IP literals.
    if (part === undefined || !/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets[i] = n;
  }
  return octets;
}

/** True when the IPv4 literal falls in a private or reserved range. */
function isPrivateIPv4(o: [number, number, number, number]): boolean {
  const [a, b] = o;
  switch (a) {
    case 0: // 0.0.0.0/8 — "this host"
      return true;
    case 10: // 10.0.0.0/8 — private class A
      return true;
    case 100: // 100.64.0.0/10 — CGNAT shared address space
      return b >= 64 && b <= 127;
    case 127: // 127.0.0.0/8 — loopback
      return true;
    case 169: // 169.254.0.0/16 — link-local (incl. 169.254.169.254 metadata)
      return b === 254;
    case 172: // 172.16.0.0/12 — private class B
      return b >= 16 && b <= 31;
    case 192: // 192.168.0.0/16 — private class C
      return b === 168;
    default:
      return false;
  }
}

/**
 * Determine whether a URL is safe to fetch.
 *
 * Rejects non-http(s) schemes, the literal "localhost" / ".localhost" TLD,
 * all bracketed IPv6 addresses (Workers use IPv4), and IPv4 literals that fall
 * in private or reserved ranges. Public DNS hostnames are permitted.
 */
export function isUrlSafe(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // Only http and https are permitted.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  const host = parsed.hostname.toLowerCase();

  // Reject the literal "localhost" and the ".localhost" TLD.
  if (host === "localhost" || host.endsWith(".localhost")) {
    return false;
  }

  // IPv6 in URLs is always bracketed (RFC 3986). Reject all of it — Workers
  // communicate over IPv4 and we have no need to fetch raw IPv6 endpoints.
  if (host.startsWith("[")) {
    return false;
  }

  // IPv4 literal check.
  const octets = parseIPv4(host);
  if (octets) {
    return !isPrivateIPv4(octets);
  }

  // Public DNS hostname — allow (the model decides, the runtime resolves).
  return true;
}
