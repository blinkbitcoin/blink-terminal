/**
 * @jest-environment node
 *
 * Server-side counterpart to the modal's insecure-origin pre-flight.
 *
 * A terminal served over plain HTTP on a non-localhost origin cannot complete
 * NIP-46 sign-in: browsers discard the `Secure` binding cookie, so every poll
 * arrives unbound and gets a 404. The browser gets an actionable message; this
 * warning makes the same misconfiguration visible in the server log, where an
 * operator is actually looking during an incident.
 *
 * It fires at most once per process — a warning printed on every sign-in
 * attempt would be noise in exactly the situation where the log matters.
 */

import {
  warnIfInsecureOrigin,
  __resetInsecureOriginWarningForTests,
} from "../../lib/nip46-server/request"

let warn: jest.SpyInstance

beforeEach(() => {
  __resetInsecureOriginWarningForTests()
  warn = jest.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
})

describe("warnIfInsecureOrigin", () => {
  it("warns for plain HTTP on a routable host, naming the origin and the fix", () => {
    warnIfInsecureOrigin("http://192.168.0.101:3000")

    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0][0])
    expect(message).toContain("192.168.0.101:3000")
    expect(message).toContain("HTTPS")
  })

  it("warns only once, however many sign-ins are attempted", () => {
    warnIfInsecureOrigin("http://192.168.0.101:3000")
    warnIfInsecureOrigin("http://192.168.0.101:3000")
    warnIfInsecureOrigin("http://pos.local")

    expect(warn).toHaveBeenCalledTimes(1)
  })

  it("stays silent over HTTPS", () => {
    warnIfInsecureOrigin("https://terminal.staging.blinkbtc.com")

    expect(warn).not.toHaveBeenCalled()
  })

  it.each(["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"])(
    "stays silent for the secure-context loopback origin %s",
    (origin) => {
      warnIfInsecureOrigin(origin)

      // Browsers treat loopback as a secure context, so the cookie is kept and
      // local development is genuinely fine.
      expect(warn).not.toHaveBeenCalled()
    },
  )
})
