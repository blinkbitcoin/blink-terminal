import crypto from "crypto"

import jwt from "jsonwebtoken"

import { getApiUrl } from "./config/api"
import { envKeyring } from "./crypto/keyring"

const JWT_SECRET: string = (() => {
  const secret = process.env.JWT_SECRET
  if (!secret) {
    throw new Error("JWT_SECRET environment variable is required")
  }
  return secret
})()

interface SessionPayload {
  username: string
  id: string
  created: number
}

interface BlinkApiResponse {
  errors?: unknown[]
  data?: {
    me?: {
      id?: string
      username?: string
    }
  }
}

class AuthManager {
  // Generate secure user session
  static generateSession(username: string): string {
    const payload: SessionPayload = {
      username,
      id: crypto.randomUUID(),
      created: Date.now(),
    }

    return jwt.sign(payload, JWT_SECRET, { expiresIn: "24h" })
  }

  // Verify user session
  static verifySession(token: string | undefined): SessionPayload | null {
    if (!token) return null
    try {
      return jwt.verify(token, JWT_SECRET) as SessionPayload
    } catch (_err: unknown) {
      return null
    }
  }

  // Encrypt a secret for storage: authenticated v2 ciphertext under the
  // current ENCRYPTION_KEY (lib/crypto/keyring.js, blink-wip#1587).
  static encryptApiKey(apiKey: string): string {
    return envKeyring().encrypt(apiKey)
  }

  // Decrypt a stored secret: v2 (any configured key, selected by key id) or
  // legacy CryptoJS ciphertext. Null when it cannot be decrypted.
  static decryptApiKey(encryptedKey: string): string | null {
    return envKeyring().decrypt(encryptedKey)
  }

  // Validate Blink API key
  static async validateBlinkApiKey(apiKey: string): Promise<boolean> {
    try {
      const response: Response = await fetch(getApiUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": apiKey,
        },
        body: JSON.stringify({
          query: "query { me { id username } }",
        }),
      })

      const data: BlinkApiResponse = await response.json()
      return !data.errors && !!data.data?.me?.id
    } catch (err: unknown) {
      console.error("API validation error:", err)
      return false
    }
  }
}

export default AuthManager
