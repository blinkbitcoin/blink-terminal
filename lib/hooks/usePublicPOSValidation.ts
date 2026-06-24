import { useState, useEffect } from "react"

import { getEnvironment } from "../config/api"

interface ValidationError {
  message: string
  suggestion: string
  environment: "production" | "staging"
  canSwitchEnv: boolean
}

interface UsePublicPOSValidationParams {
  username: string
}

interface UsePublicPOSValidationReturn {
  validationError: ValidationError | null
  validating: boolean
  validatedWalletCurrency: string
}

/**
 * usePublicPOSValidation - Validates a Blink username against the current environment
 *
 * On mount, queries the Blink GraphQL API (production or staging) to check if the
 * username has a default wallet. Sets validation error with environment info if not found.
 *
 * @param {Object} deps
 * @param {string} deps.username - The Blink username to validate
 * @returns {Object} { validationError, validating, validatedWalletCurrency }
 */
export function usePublicPOSValidation({
  username,
}: UsePublicPOSValidationParams): UsePublicPOSValidationReturn {
  const [validationError, setValidationError] = useState<ValidationError | null>(null)
  const [validating, setValidating] = useState(true) // Start true - validate on mount
  const [validatedWalletCurrency, setValidatedWalletCurrency] = useState("BTC")

  useEffect(() => {
    const validateUser = async () => {
      setValidating(true)
      setValidationError(null)

      const currentEnv = getEnvironment()

      console.log(`[PublicPOS] Validating user '${username}' on ${currentEnv}`)

      try {
        // Resolve via custodial-first → LNURL fallback so self-custodial
        // (Spark) usernames are recognized even without a custodial wallet.
        const response = await fetch("/api/blink/resolve-receiver", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, environment: currentEnv }),
        })

        const data = await response.json()

        if (!response.ok || !data.exists) {
          console.log(`[PublicPOS] User '${username}' not found on ${currentEnv}`)

          const envLabel =
            currentEnv === "staging" ? "staging/signet" : "production/mainnet"

          setValidationError({
            message: `User '${username}' does not exist on ${envLabel}.`,
            suggestion:
              currentEnv === "staging"
                ? `This username may exist on mainnet but not staging. Switch to production mode or use a staging username.`
                : `This username doesn't exist. Check spelling or try a different username.`,
            environment: currentEnv,
            canSwitchEnv: true,
          })
        } else {
          console.log(
            `[PublicPOS] User '${username}' validated on ${currentEnv}:`,
            data.type,
          )
          setValidatedWalletCurrency(data.walletCurrency || "BTC")
          setValidationError(null)
        }
      } catch (error) {
        console.error("[PublicPOS] Error validating user:", error)
        setValidationError({
          message: `Failed to validate user '${username}'.`,
          suggestion: "Please check your internet connection and try again.",
          environment: currentEnv,
          canSwitchEnv: false,
        })
      } finally {
        setValidating(false)
      }
    }

    validateUser()
  }, [username])

  return { validationError, validating, validatedWalletCurrency }
}
