import { useState, useEffect } from "react"

import { getEnvironment } from "../config/api"

/**
 * useReceiverType
 *
 * Derives whether the active receiving Blink account is a **self-custodial
 * (Spark) Lightning-address** account, as opposed to a custodial Blink wallet.
 *
 * Why this is needed: an account whose `type === "ln-address"` can be EITHER
 * custodial or self-custodial (Spark) — `blink.sv` serves LNURL for both, so the
 * domain/type alone does not tell us. The custodial-vs-Spark distinction is only
 * known by resolving server-side via `/api/blink/resolve-receiver` (custodial
 * `accountDefaultWallet` probe → LNURL-pay fallback). `type: "lnaddress"` from
 * that endpoint means "resolved via LNURL only" ⇒ self-custodial (Spark).
 *
 * Self-custodial receivers have no escrow account, so tip forwarding and payment
 * splits are impossible. Callers use `isSparkLnAddress` to suppress Tip Options
 * and Split Profiles in the authenticated POS.
 *
 * Resolution is ephemeral (resolved per session on account change, cached by
 * username for the lifetime of the hook instance) — not persisted.
 *
 * Fail-safe (suppress-until-confirmed-custodial): for an `ln-address` account,
 * while resolution is pending OR if it fails, `isSparkLnAddress` is `true` so we
 * never show a misleading tip/split UI on what might be a Spark wallet. Only a
 * confirmed `custodial` result flips it to `false`. Non-`ln-address` accounts
 * (API-key custodial, npub-cash) are always `false`.
 */

interface ReceiverTypeAccount {
  username?: string
  type?: string
}

interface UseReceiverTypeReturn {
  /** True when the active receive wallet is a self-custodial (Spark) LN address. */
  isSparkLnAddress: boolean
  /** True while the receiver type is being resolved for an ln-address account. */
  receiverTypeLoading: boolean
}

export function useReceiverType(
  activeBlinkAccount: ReceiverTypeAccount | null | undefined,
): UseReceiverTypeReturn {
  const isLnAddressAccount = activeBlinkAccount?.type === "ln-address"
  const username = activeBlinkAccount?.username

  // Suppress-until-confirmed-custodial: ln-address accounts start as "spark"
  // until a custodial result is confirmed; everything else is custodial.
  const [isSparkLnAddress, setIsSparkLnAddress] = useState<boolean>(
    Boolean(isLnAddressAccount),
  )
  const [receiverTypeLoading, setReceiverTypeLoading] = useState<boolean>(false)

  useEffect(() => {
    // Non-ln-address accounts (API-key custodial, npub-cash, or none) are never
    // self-custodial Spark receivers.
    if (!isLnAddressAccount || !username) {
      setIsSparkLnAddress(false)
      setReceiverTypeLoading(false)
      return
    }

    let cancelled = false

    const resolve = async () => {
      // Fail-safe default while resolving: treat as Spark (suppress tips/splits).
      setIsSparkLnAddress(true)
      setReceiverTypeLoading(true)

      try {
        const response = await fetch("/api/blink/resolve-receiver", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, environment: getEnvironment() }),
        })

        const data = await response.json().catch(() => null)

        if (cancelled) return

        // Only a confirmed custodial result enables tips/splits. Anything else
        // (lnaddress, not-found, error) keeps suppression on.
        const custodial = response.ok && data?.exists && data?.type === "custodial"
        setIsSparkLnAddress(!custodial)
      } catch (err) {
        if (cancelled) return
        console.warn("[useReceiverType] Failed to resolve receiver type:", err)
        // Keep suppression on (isSparkLnAddress stays true) on error.
        setIsSparkLnAddress(true)
      } finally {
        if (!cancelled) setReceiverTypeLoading(false)
      }
    }

    resolve()

    return () => {
      cancelled = true
    }
  }, [isLnAddressAccount, username])

  return { isSparkLnAddress, receiverTypeLoading }
}

export default useReceiverType
