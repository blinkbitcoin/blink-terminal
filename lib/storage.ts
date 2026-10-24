import crypto from "crypto"

import type { QueryResult } from "pg"

import AuthManager from "./auth"
import { getSharedPool } from "./db"

interface UserData {
  apiKey?: string | null
  lastUpdated?: number
  [key: string]: unknown
}

interface UserRecordRow {
  user_hash: string
  data: UserData
}

/**
 * Per-user data store backed by PostgreSQL (table `user_records`).
 *
 * Previously this wrote per-user JSON files to a pod-local `.data` directory.
 * With multiple application replicas, each pod held its own copy of a user's
 * data, so wallets/profiles/preferences diverged across devices (whichever pod
 * served a request decided what the user saw). Persisting to the shared
 * PostgreSQL instance makes user data consistent across all replicas.
 *
 * The public API is unchanged: callers pass an opaque `userId` (e.g.
 * "nostr:<pubkey>", "nostr_<pubkey>", or a legacy username) and receive/save an
 * opaque blob. Sensitive fields (`apiKey`) are encrypted at rest exactly as
 * before; other sensitive fields (NWC URIs, nested API keys) are encrypted by
 * the calling route before they reach this layer.
 */
class StorageManager {
  /**
   * Stable per-user key: the FULL SHA-256 hex (64 chars) of the userId.
   *
   * The full digest (rather than a truncated prefix) avoids collisions where
   * two distinct identities could map to the same record and read each other's
   * API keys. Retained as a method name for backwards compatibility with
   * existing callers/tests; it now returns the primary key used in the
   * `user_records` table rather than a filesystem path.
   */
  getUserStoragePath(userId: string): string {
    return crypto.createHash("sha256").update(userId).digest("hex")
  }

  // Save user data (API keys, preferences). Upserts the user's record.
  async saveUserData(userId: string, data: UserData): Promise<boolean> {
    try {
      const userHash: string = this.getUserStoragePath(userId)

      const encryptedData: UserData = {
        ...data,
        apiKey: data.apiKey ? AuthManager.encryptApiKey(data.apiKey) : null,
        lastUpdated: Date.now(),
      }

      await getSharedPool().query(
        `INSERT INTO user_records (user_hash, data, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (user_hash)
         DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
        [userHash, JSON.stringify(encryptedData)],
      )

      return true
    } catch (err: unknown) {
      console.error("[StorageManager] Failed to save user data:", err)
      return false
    }
  }

  // Load user data
  async loadUserData(userId: string): Promise<UserData | null> {
    try {
      const userHash: string = this.getUserStoragePath(userId)

      const result: QueryResult<UserRecordRow> = await getSharedPool().query(
        `SELECT data FROM user_records WHERE user_hash = $1`,
        [userHash],
      )

      if (result.rowCount === 0) {
        return null
      }

      // `data` is JSONB; the pg driver already parses it into an object.
      const data: UserData = (result.rows[0].data || {}) as UserData

      // Decrypt API key
      if (data.apiKey) {
        data.apiKey = AuthManager.decryptApiKey(data.apiKey)
      }

      return data
    } catch (err: unknown) {
      console.error("[StorageManager] Failed to load user data:", err)
      return null
    }
  }

  // Delete user data
  async deleteUserData(userId: string): Promise<boolean> {
    try {
      const userHash: string = this.getUserStoragePath(userId)

      const result: QueryResult = await getSharedPool().query(
        `DELETE FROM user_records WHERE user_hash = $1`,
        [userHash],
      )

      return (result.rowCount ?? 0) > 0
    } catch (err: unknown) {
      console.error("[StorageManager] Failed to delete user data:", err)
      return false
    }
  }

  // List all users (for admin purposes). Returns the per-user hashes, matching
  // the previous filesystem behavior (which returned the hashed filename stem).
  async listUsers(): Promise<string[]> {
    try {
      const result: QueryResult<{ user_hash: string }> = await getSharedPool().query(
        `SELECT user_hash FROM user_records ORDER BY updated_at DESC`,
      )
      return result.rows.map((row: { user_hash: string }) => row.user_hash)
    } catch (err: unknown) {
      console.error("[StorageManager] Failed to list users:", err)
      return []
    }
  }
}

export default new StorageManager()
export { StorageManager }
