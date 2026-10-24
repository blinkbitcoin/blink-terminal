import { bech32 } from "bech32"
import type { NextApiRequest, NextApiResponse } from "next"

import { baseLogger } from "@/lib/logger"
import { withRateLimit, RATE_LIMIT_PUBLIC } from "@/lib/rate-limit"
import {
  SafeFetchError,
  safeFetchJson,
  safeFetchJsonResponse,
} from "@/lib/server/safe-fetch-json"

type WithdrawRequestParams = {
  tag: "withdrawRequest"
  callback: string
  k1: string
}

const MAX_LNURL_LENGTH = 2048
const MAX_K1_LENGTH = 128
const BOLT11_REGEX = /^ln[a-z0-9]{20,2000}$/i

const decodeLnurlToUrl = (lnurl: string): URL | null => {
  const trimmed = lnurl.trim()

  if (/^lnurl1[a-z0-9]+$/i.test(trimmed)) {
    try {
      const { words } = bech32.decode(trimmed.toLowerCase(), MAX_LNURL_LENGTH * 2)
      const decoded = Buffer.from(bech32.fromWords(words)).toString("utf8")
      return new URL(decoded)
    } catch {
      return null
    }
  }

  if (/^lnurlw:\/\//i.test(trimmed)) {
    try {
      return new URL(`https://${trimmed.slice("lnurlw://".length)}`)
    } catch {
      return null
    }
  }

  try {
    return new URL(trimmed)
  } catch {
    return null
  }
}

const isRecord = (data: unknown): data is Record<string, unknown> =>
  typeof data === "object" && data !== null && !Array.isArray(data)

const isWithdrawRequestParams = (data: unknown): data is WithdrawRequestParams =>
  isRecord(data) &&
  data.tag === "withdrawRequest" &&
  typeof data.callback === "string" &&
  typeof data.k1 === "string"

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  // Pages Router pre-parses JSON bodies; normalize non-object bodies here.
  let body: unknown = req.body
  if (typeof body === "string") {
    try {
      body = JSON.parse(body)
    } catch {
      return res.status(400).json({ error: "Invalid JSON body" })
    }
  }

  if (!isRecord(body)) {
    return res.status(400).json({ error: "Invalid JSON body" })
  }

  const { lnurl, paymentRequest } = body

  if (
    typeof lnurl !== "string" ||
    lnurl.length === 0 ||
    lnurl.length > MAX_LNURL_LENGTH
  ) {
    return res.status(400).json({ error: "Missing or invalid lnurl parameter" })
  }

  if (typeof paymentRequest !== "string" || !BOLT11_REGEX.test(paymentRequest)) {
    return res.status(400).json({ error: "Missing or invalid paymentRequest parameter" })
  }

  const serviceUrl = decodeLnurlToUrl(lnurl)
  if (!serviceUrl || serviceUrl.protocol !== "https:") {
    return res.status(400).json({ error: "Invalid lnurl" })
  }

  try {
    // 1. Fetch LNURL service params through the egress-safe fetcher (never trust
    //    query-string params: js-lnurl.getParams is gone).
    const serviceResponse = await safeFetchJsonResponse(serviceUrl.toString())
    const params = serviceResponse.data

    if (!isWithdrawRequestParams(params) || params.k1.length > MAX_K1_LENGTH) {
      return res
        .status(400)
        .json({ error: "Not a properly configured lnurl withdraw tag" })
    }

    // 2. The callback must be https and stay on the (post-redirect) service host.
    let callbackUrl: URL
    try {
      callbackUrl = new URL(params.callback)
    } catch {
      return res.status(400).json({ error: "Invalid callback URL" })
    }

    if (
      callbackUrl.protocol !== "https:" ||
      callbackUrl.hostname !== new URL(serviceResponse.url).hostname
    ) {
      return res.status(400).json({ error: "Invalid callback URL" })
    }

    callbackUrl.searchParams.set("k1", params.k1)
    callbackUrl.searchParams.set("pr", paymentRequest)

    // 3. Relay ONLY LUD-03 {status, reason} — kills the read-back channel.
    const callbackResponse = await safeFetchJson(callbackUrl.toString())
    const status =
      isRecord(callbackResponse) && typeof callbackResponse.status === "string"
        ? callbackResponse.status
        : ""

    if (status.toUpperCase() === "OK") {
      return res.status(200).json({ status: "OK" })
    }

    const reason =
      isRecord(callbackResponse) && typeof callbackResponse.reason === "string"
        ? callbackResponse.reason.slice(0, 280)
        : "Withdraw request failed"
    return res.status(400).json({ status: "ERROR", reason })
  } catch (error) {
    if (error instanceof SafeFetchError) {
      return res.status(400).json({ error: "LNURL service unreachable or not allowed" })
    }

    baseLogger.error({ err: error }, "Error processing LNURL request")
    return res.status(500).json({ error: "Failed to process LNURL request" })
  }
}

export default withRateLimit(handler, RATE_LIMIT_PUBLIC, "lnurl-proxy")
