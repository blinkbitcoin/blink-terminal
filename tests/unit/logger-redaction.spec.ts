/** @jest-environment node */

/**
 * blink-wip#1590: the shared pino logger redacts secret-bearing fields
 * wherever a structured log object carries them. Uses the real
 * loggerOptions with an in-memory destination.
 */

import pino from "pino"

import { loggerOptions, REDACT_PATHS } from "../../lib/logger"

const capture = () => {
  const lines: string[] = []
  const logger = pino(loggerOptions, { write: (line: string) => lines.push(line) })
  return {
    logger,
    last: () => JSON.parse(lines[lines.length - 1]) as Record<string, unknown>,
  }
}

describe("baseLogger redaction", () => {
  it("redacts top-level and nested secret fields", () => {
    const { logger, last } = capture()
    logger.info(
      {
        apiKey: "blink_live_key",
        password: "hunter2",
        nsec: "nsec1secret",
        card: {
          k0: "k0hex",
          k1: "k1hex",
          k2: "k2hex",
          k3: "k3hex",
          k4: "k4hex",
          apiKey: "nested",
        },
        session: { token: "jwt", secret: "s" },
        cardId: "card-1",
        amount: 1000,
      },
      "event",
    )
    const out = last()
    const text = JSON.stringify(out)
    for (const secret of [
      "blink_live_key",
      "hunter2",
      "nsec1secret",
      "k0hex",
      "k1hex",
      "k2hex",
      "k3hex",
      "k4hex",
      "nested",
      "jwt",
    ]) {
      expect(text).not.toContain(secret)
    }
    expect(out.apiKey).toBe("[REDACTED]")
    expect((out.card as Record<string, unknown>).k1).toBe("[REDACTED]")
    // Non-secret context survives
    expect(out.cardId).toBe("card-1")
    expect(out.amount).toBe(1000)
    expect(out.msg).toBe("event")
  })

  it("redacts auth headers, cookies and x-api-key, also under req", () => {
    const { logger, last } = capture()
    logger.warn({
      headers: {
        "authorization": "Bearer a",
        "cookie": "auth-token=b",
        "x-api-key": "c",
        "host": "h",
      },
      req: { headers: { "authorization": "Bearer d", "set-cookie": "e" } },
    })
    const text = JSON.stringify(last())
    for (const secret of ["Bearer a", "auth-token=b", '"c"', "Bearer d", '"e"']) {
      expect(text).not.toContain(secret)
    }
    expect(text).toContain('"host":"h"')
  })

  it("covers every documented field at both depths", () => {
    for (const field of ["apiKey", "k1", "token", "password", "nsec", "privateKey"]) {
      expect(REDACT_PATHS).toEqual(expect.arrayContaining([field, `*.${field}`]))
    }
  })
})
