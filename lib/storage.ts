import crypto from "crypto"
import fs from "fs/promises"
import path from "path"

import AuthManager from "./auth"

interface UserData {
  apiKey?: string | null
  lastUpdated?: number
  [key: string]: unknown
}

class StorageManager {
  storageDir: string

  constructor() {
    this.storageDir = path.join(process.cwd(), ".data")
    this.ensureDataDir()
  }

  async ensureDataDir(): Promise<void> {
    try {
      await fs.mkdir(this.storageDir, { recursive: true })
    } catch (err: unknown) {
      console.error("Failed to create data directory:", err)
    }
  }

  // Get user-specific storage path.
  //
  // Uses the FULL SHA-256 hex (64 chars). Previously this was truncated to 16
  // hex chars (64 bits), which has a non-negligible collision risk across many
  // users — two distinct identities could map to the same file and read each
  // other's API keys. The full digest removes that risk.
  getUserStoragePath(userId: string): string {
    const hashedId: string = crypto.createHash("sha256").update(userId).digest("hex")
    return path.join(this.storageDir, `user_${hashedId}.json`)
  }

  // Legacy (pre-collision-fix) path using a 16-hex truncated hash. Retained so
  // existing records remain readable and can be migrated forward on next write.
  getLegacyUserStoragePath(userId: string): string {
    const hashedId: string = crypto
      .createHash("sha256")
      .update(userId)
      .digest("hex")
      .substring(0, 16)

    return path.join(this.storageDir, `user_${hashedId}.json`)
  }

  // Save user data (API keys, preferences)
  async saveUserData(userId: string, data: UserData): Promise<boolean> {
    try {
      console.log("[StorageManager] Saving data for user:", userId)
      const filePath: string = this.getUserStoragePath(userId)
      console.log("[StorageManager] File path:", filePath)

      const encryptedData: UserData = {
        ...data,
        apiKey: data.apiKey ? AuthManager.encryptApiKey(data.apiKey) : null,
        lastUpdated: Date.now(),
      }

      console.log("[StorageManager] Writing file...")
      await fs.writeFile(filePath, JSON.stringify(encryptedData, null, 2))
      console.log("[StorageManager] ✓ File written successfully")
      return true
    } catch (err: unknown) {
      console.error("[StorageManager] Failed to save user data:", err)
      return false
    }
  }

  // Load user data
  async loadUserData(userId: string): Promise<UserData | null> {
    let fileContent: string | null = null

    // Prefer the full-hash path; fall back to the legacy truncated-hash path so
    // records written before the collision fix remain readable.
    try {
      fileContent = await fs.readFile(this.getUserStoragePath(userId), "utf8")
    } catch (_err: unknown) {
      try {
        fileContent = await fs.readFile(this.getLegacyUserStoragePath(userId), "utf8")
      } catch (_legacyErr: unknown) {
        return null
      }
    }

    try {
      const data: UserData = JSON.parse(fileContent) as UserData

      // Decrypt API key
      if (data.apiKey) {
        data.apiKey = AuthManager.decryptApiKey(data.apiKey)
      }

      return data
    } catch (_err: unknown) {
      return null
    }
  }

  // Delete user data (both the full-hash and legacy truncated-hash files).
  async deleteUserData(userId: string): Promise<boolean> {
    let deleted = false
    for (const filePath of [
      this.getUserStoragePath(userId),
      this.getLegacyUserStoragePath(userId),
    ]) {
      try {
        await fs.unlink(filePath)
        deleted = true
      } catch (_err: unknown) {
        // ignore missing file
      }
    }
    return deleted
  }

  // List all users (for admin purposes)
  async listUsers(): Promise<string[]> {
    try {
      const files: string[] = await fs.readdir(this.storageDir)
      return files
        .filter((file: string) => file.startsWith("user_") && file.endsWith(".json"))
        .map((file: string) => file.replace("user_", "").replace(".json", ""))
    } catch (_err: unknown) {
      return []
    }
  }
}

export default new StorageManager()
export { StorageManager }
