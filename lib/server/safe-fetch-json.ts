import { lookup } from "node:dns/promises"
import https from "node:https"
import { isIP, type LookupFunction } from "node:net"

const MAX_REDIRECTS = 3
const DEFAULT_MAX_BODY_BYTES = 16 * 1024
const TIMEOUT_MS = 5_000
const DEADLINE_MS = 15_000

/**
 * Stable failure categories. Callers branch on `code`, never on `message`
 * (messages are human-readable and may change).
 */
export type SafeFetchErrorCode =
  | "INVALID_URL"
  | "NOT_HTTPS"
  | "BLOCKED_ADDRESS"
  | "REDIRECT"
  | "HTTP_STATUS"
  | "TOO_LARGE"
  | "INVALID_JSON"
  | "TIMEOUT"
  | "DEADLINE"
  | "NETWORK"

export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode

  constructor(message: string, code: SafeFetchErrorCode) {
    super(message)
    this.name = "SafeFetchError"
    this.code = code
  }
}

const BLOCKED_V4: Array<[number, number]> = [
  [0x00000000, 0xff000000], // 0.0.0.0/8      "this" network
  [0x0a000000, 0xff000000], // 10.0.0.0/8     RFC1918
  [0x64400000, 0xffc00000], // 100.64.0.0/10  CGNAT
  [0x7f000000, 0xff000000], // 127.0.0.0/8    loopback
  [0xa9fe0000, 0xffff0000], // 169.254.0.0/16 link-local (cloud metadata)
  [0xac100000, 0xfff00000], // 172.16.0.0/12  RFC1918
  [0xc0000000, 0xffffff00], // 192.0.0.0/24   IETF protocol assignments
  [0xc0000200, 0xffffff00], // 192.0.2.0/24   TEST-NET-1
  [0xc0586300, 0xffffff00], // 192.88.99.0/24 6to4 relay anycast
  [0xc0a80000, 0xffff0000], // 192.168.0.0/16 RFC1918
  [0xc6120000, 0xfffe0000], // 198.18.0.0/15  benchmarking
  [0xc6336400, 0xffffff00], // 198.51.100.0/24 TEST-NET-2
  [0xcb007100, 0xffffff00], // 203.0.113.0/24 TEST-NET-3
  [0xe0000000, 0xf0000000], // 224.0.0.0/4    multicast
  [0xf0000000, 0xf0000000], // 240.0.0.0/4    reserved
]

const ipv4ToInt = (ip: string): number =>
  ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0

const isBlockedIpv4 = (ip: string): boolean => {
  const address = ipv4ToInt(ip)
  return BLOCKED_V4.some(([network, mask]) => {
    const masked = (address & mask) >>> 0
    return masked === network
  })
}

const mappedIpv4 = (ip: string): string | null => {
  const match = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
  if (!match) return null

  const high = Number.parseInt(match[1], 16)
  const low = Number.parseInt(match[2], 16)
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
}

const isBlockedIpv6 = (ip: string): boolean => {
  const mapped = mappedIpv4(ip)
  if (mapped) return isBlockedIpv4(mapped)

  const firstGroup = Number.parseInt(ip.split(":")[0] || "0", 16)
  if (Number.isNaN(firstGroup) || (firstGroup & 0xe000) !== 0x2000) return true

  if (/^2001:db8:/i.test(ip)) return true
  if (firstGroup !== 0x3fff) return false

  const secondGroup = Number.parseInt(ip.split(":")[1] || "0", 16)
  return secondGroup <= 0x0fff
}

const isBlockedAddress = ({
  address,
  family,
}: {
  address: string
  family: number
}): boolean => {
  if (family === 4) return isBlockedIpv4(address)
  if (family === 6) return isBlockedIpv6(address)
  return true
}

type ResolvedAddress = { address: string; family: number }

const resolveAllowedAddresses = async (hostname: string): Promise<ResolvedAddress[]> => {
  const unwrappedHostname = hostname.replace(/^\[|\]$/g, "")
  const literalFamily = isIP(unwrappedHostname)
  const addresses = literalFamily
    ? [{ address: unwrappedHostname, family: literalFamily }]
    : await lookup(unwrappedHostname, { all: true, verbatim: true })
  const allowed = addresses.filter(
    ({ address, family }) => !isBlockedAddress({ address, family }),
  )

  if (allowed.length === 0) {
    throw new SafeFetchError(
      "hostname does not resolve to a public address",
      "BLOCKED_ADDRESS",
    )
  }

  return allowed
}

const pinnedLookup =
  (addresses: ResolvedAddress[]): LookupFunction =>
  (_hostname, options, callback) => {
    const matching = options.family
      ? addresses.filter(({ family }) => family === options.family)
      : addresses

    if (matching.length === 0) {
      callback(
        new SafeFetchError("no address matches the requested family", "BLOCKED_ADDRESS"),
        "",
      )
      return
    }

    if (options.all) {
      callback(null, matching)
      return
    }

    callback(null, matching[0].address, matching[0].family)
  }

const requestJsonOnce = async ({
  url,
  redirectsLeft,
  signal,
  maxBodyBytes,
}: {
  url: URL
  redirectsLeft: number
  signal: AbortSignal
  maxBodyBytes: number
}): Promise<{ data: unknown } | { redirect: URL }> => {
  if (url.protocol !== "https:") {
    throw new SafeFetchError("only https URLs are allowed", "NOT_HTTPS")
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  const addresses = await resolveAllowedAddresses(hostname)

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        lookup: pinnedLookup(addresses),
        headers: { "Accept": "application/json", "User-Agent": "blink-pay/1.0" },
        timeout: TIMEOUT_MS,
        signal,
      },
      (res) => {
        const status = res.statusCode ?? 0

        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume()
          if (redirectsLeft <= 0) {
            reject(new SafeFetchError("too many redirects", "REDIRECT"))
            return
          }

          const location = res.headers.location
          if (!location) {
            reject(new SafeFetchError("redirect without a location", "REDIRECT"))
            return
          }

          try {
            resolve({ redirect: new URL(location, url) })
          } catch {
            reject(new SafeFetchError("invalid redirect target", "REDIRECT"))
          }
          return
        }

        if (status < 200 || status >= 300) {
          res.resume()
          reject(new SafeFetchError(`upstream returned HTTP ${status}`, "HTTP_STATUS"))
          return
        }

        const chunks: Uint8Array[] = []
        let size = 0
        let stopped = false

        res.on("data", (chunk: Buffer) => {
          if (stopped) return

          size += chunk.length
          if (size > maxBodyBytes) {
            stopped = true
            req.destroy(new SafeFetchError("response too large", "TOO_LARGE"))
            return
          }
          chunks.push(Uint8Array.from(chunk))
        })
        res.on("end", () => {
          if (stopped) return

          try {
            resolve({ data: JSON.parse(Buffer.concat(chunks).toString("utf8")) })
          } catch {
            reject(new SafeFetchError("invalid JSON from upstream", "INVALID_JSON"))
          }
        })
        res.on("error", reject)
      },
    )

    req.on("timeout", () =>
      req.destroy(new SafeFetchError("upstream request timed out", "TIMEOUT")),
    )
    req.on("error", reject)
    req.end()
  })
}

type SafeFetchJsonResponse = { data: unknown; url: string }

const fetchWithRedirects = async ({
  url,
  redirectsLeft,
  signal,
  maxBodyBytes,
}: {
  url: URL
  redirectsLeft: number
  signal: AbortSignal
  maxBodyBytes: number
}): Promise<SafeFetchJsonResponse> => {
  const result = await requestJsonOnce({ url, redirectsLeft, signal, maxBodyBytes })
  if ("data" in result) return { data: result.data, url: url.toString() }
  return fetchWithRedirects({
    url: result.redirect,
    redirectsLeft: redirectsLeft - 1,
    signal,
    maxBodyBytes,
  })
}

const withRequestDeadline = ({
  controller,
  operation,
}: {
  controller: AbortController
  operation: () => Promise<SafeFetchJsonResponse>
}): Promise<SafeFetchJsonResponse> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new SafeFetchError("upstream request deadline exceeded", "DEADLINE"))
      controller.abort()
    }, DEADLINE_MS)
    operation().then(
      (result) => {
        clearTimeout(timer)
        resolve(result)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })

export type SafeFetchJsonOptions = {
  /** Response body cap in bytes (default 16 KiB). */
  maxBodyBytes?: number
}

/** Reject a hostname that is an IP literal or does not resolve to a public address. */
export const assertPublicHostname = async (hostname: string): Promise<void> => {
  if (isIP(hostname.replace(/^\[|\]$/g, ""))) {
    throw new SafeFetchError("IP literals are not allowed", "BLOCKED_ADDRESS")
  }
  await resolveAllowedAddresses(hostname)
}

export const safeFetchJsonResponse = async (
  input: string,
  { maxBodyBytes = DEFAULT_MAX_BODY_BYTES }: SafeFetchJsonOptions = {},
): Promise<SafeFetchJsonResponse> => {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new SafeFetchError("invalid URL", "INVALID_URL")
  }

  const controller = new AbortController()

  try {
    return await withRequestDeadline({
      controller,
      operation: () =>
        fetchWithRedirects({
          url,
          redirectsLeft: MAX_REDIRECTS,
          signal: controller.signal,
          maxBodyBytes,
        }),
    })
  } catch (error) {
    if (error instanceof SafeFetchError) throw error
    throw new SafeFetchError("upstream request failed", "NETWORK")
  }
}

export const safeFetchJson = async (
  input: string,
  options?: SafeFetchJsonOptions,
): Promise<unknown> => (await safeFetchJsonResponse(input, options)).data
