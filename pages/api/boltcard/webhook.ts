import type { NextApiRequest, NextApiResponse } from "next"

/**
 * Former Bolt Card top-up webhook — RETIRED (410 Gone).
 *
 * It credited card balances on an unauthenticated `{ paymentHash, status:
 * "PAID" }` claim. Top-ups are processed by the Svix-signed Blink webhook
 * (`/api/blink/webhook`) and by polling on a verified balance tap; both go
 * through `processTopUpPayment`, which verifies the payment with Blink before
 * crediting. This route stays retired regardless of BOLTCARD_SPEND_ENABLED.
 */
export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  return res.status(410).json({ error: "Gone" })
}

// Never parse the request body.
export const config = {
  api: {
    bodyParser: false,
  },
}
