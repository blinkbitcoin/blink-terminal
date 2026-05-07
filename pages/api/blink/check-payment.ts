import type { NextApiRequest, NextApiResponse } from "next"

/**
 * API endpoint to check if a payment has been received for a given payment hash
 *
 * Used when the app regains focus after being in the background to check
 * if a pending invoice was paid while the user was away.
 */

import BlinkAPI from "../../../lib/blink-api"
import { getApiUrlForEnvironment } from "../../../lib/config/api"
import { baseLogger } from "../../../lib/logger"
import { withRateLimit, RATE_LIMIT_READ } from "../../../lib/rate-limit"
import { validateBody, checkPaymentSchema } from "../../../lib/validation"

const logger = baseLogger.child({ module: "check-payment" })

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    const parsed = validateBody(req, res, checkPaymentSchema)
    if (!parsed) return
    const { paymentHash, environment } = parsed

    // BlinkPOS credentials are set per-deployment; the `environment` value
    // only selects which Blink GraphQL URL we talk to.
    const blinkposApiKey = process.env.BLINKPOS_API_KEY
    const blinkposBtcWalletId = process.env.BLINKPOS_BTC_WALLET_ID
    const apiUrl = getApiUrlForEnvironment(environment)

    if (!blinkposApiKey || !blinkposBtcWalletId) {
      return res.status(500).json({ error: "BlinkPOS configuration missing" })
    }

    const blinkposAPI = new BlinkAPI(blinkposApiKey, apiUrl)

    // Query recent transactions and look for matching payment hash
    const query = `
      query GetRecentTransactions($walletId: WalletId!) {
        me {
          defaultAccount {
            walletById(walletId: $walletId) {
              transactions(first: 30) {
                edges {
                  node {
                    id
                    status
                    direction
                    settlementAmount
                    createdAt
                    initiationVia {
                      ... on InitiationViaLn {
                        paymentHash
                      }
                      ... on InitiationViaIntraLedger {
                        counterPartyUsername
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `

    try {
      const result = await blinkposAPI.query(query, { walletId: blinkposBtcWalletId })
      const transactions =
        result?.me?.defaultAccount?.walletById?.transactions?.edges || []

      // Find a matching receive transaction by payment hash
      const matchingTx = transactions.find(
        (edge: {
          node: {
            direction: string
            status: string
            initiationVia?: { paymentHash?: string }
            id: string
            settlementAmount: number
            createdAt: string
          }
        }) => {
          const tx = edge.node
          return (
            tx.direction === "RECEIVE" &&
            tx.status === "SUCCESS" &&
            tx.initiationVia?.paymentHash === paymentHash
          )
        },
      )

      if (matchingTx) {
        logger.info({ paymentHash: paymentHash.substring(0, 16) }, "Payment found")
        return res.status(200).json({
          paid: true,
          transaction: {
            id: matchingTx.node.id,
            amount: matchingTx.node.settlementAmount,
            createdAt: matchingTx.node.createdAt,
            status: matchingTx.node.status,
          },
        })
      }

      logger.debug({ paymentHash: paymentHash.substring(0, 16) }, "No payment found")
      return res.status(200).json({ paid: false })
    } catch (queryError: unknown) {
      const queryMessage =
        queryError instanceof Error ? queryError.message : "Unknown error"
      logger.error({ err: queryMessage }, "Query error")
      return res.status(200).json({
        paid: false,
        error: "Could not verify payment status",
      })
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    logger.error({ err: error }, "Failed to check payment status")
    return res.status(500).json({
      error: "Failed to check payment status",
      details: message,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_READ)
