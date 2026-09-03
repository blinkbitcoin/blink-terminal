/**
 * ProfileStorage - Manages user profiles with encrypted credential storage
 *
 * Each profile is associated with a Nostr public key and contains:
 * - Blink API accounts (encrypted)
 * - NWC connections (encrypted)
 * - Tipping settings
 * - UI preferences
 */

import CryptoUtils, { type EncryptedData } from "./CryptoUtils"

const PROFILES_STORAGE_KEY: string = "blinkpos_profiles"
const ACTIVE_PROFILE_KEY: string = "blinkpos_active_profile"

// ============= Local Profile Types =============
// These use distinct names to avoid collision with global ambient types
// in types/nostr.d.ts (EncryptedField, BlinkAccount, Profile, etc.)

/**
 * A Blink account stored in a profile.
 * Polymorphic: can be an API-key account, an ln-address account, or an npub-cash account.
 */
export interface StoredBlinkAccount {
  id: string
  type?: "ln-address" | "npub-cash"
  label: string
  apiKey?: EncryptedData
  username?: string
  walletId?: string
  walletCurrency?: string
  lightningAddress?: string
  localpart?: string
  isNpub?: boolean
  defaultCurrency?: string
  isActive: boolean
  createdAt: number
  lastUsed: number | null
}

/**
 * An NWC connection stored in a profile.
 */
export interface StoredNWCConnection {
  id: string
  label: string
  uri: EncryptedData
  capabilities?: string[]
  isActive: boolean
  createdAt: number
}

/**
 * Tipping settings stored in a profile.
 */
export interface StoredTippingSettings {
  enabled: boolean
  defaultPercentages: number[]
  customAmountEnabled: boolean
  forwardToNWC: boolean
  forwardNWCId?: string | null
  // Alternative field names used by TippingSection component
  customPercentages?: number[]
  allowCustomAmount?: boolean
}

/**
 * User preferences stored in a profile.
 */
export interface StoredPreferences {
  defaultCurrency: string
  darkMode: boolean
  sounds: boolean
  language: string
  numberFormat?: string
  // Alternative field names used by PreferencesSection component
  showSatsFirst?: boolean
  soundEnabled?: boolean
}

/**
 * A full user profile stored in localStorage.
 */
export interface StoredProfile {
  id: string
  publicKey: string
  signInMethod: string
  createdAt: number
  lastLogin?: number
  blinkAccounts: StoredBlinkAccount[]
  nwcConnections: StoredNWCConnection[]
  tippingSettings: StoredTippingSettings
  preferences: StoredPreferences
}

/**
 * Data shape for profile export/import operations.
 */
export interface ProfileExportData {
  version: number
  exportedAt: number
  profile?: StoredProfile
  profiles?: StoredProfile[]
  activeProfileId?: string
}

/**
 * Input data for adding a Blink Lightning Address account.
 */
interface BlinkLnAddressInput {
  label: string
  username: string
  walletId: string
  walletCurrency: string
  lightningAddress: string
}

/**
 * Input data for adding an npub.cash account.
 */
interface NpubCashInput {
  lightningAddress: string
  label: string
}

class ProfileStorage {
  /**
   * Get all stored profiles
   */
  static getProfiles(): StoredProfile[] {
    if (typeof localStorage === "undefined") return []

    try {
      const stored: string | null = localStorage.getItem(PROFILES_STORAGE_KEY)
      if (!stored) return []
      return JSON.parse(stored) as StoredProfile[]
    } catch (error: unknown) {
      console.error("Failed to parse profiles:", error)
      return []
    }
  }

  /**
   * Save profiles to storage
   */
  static saveProfiles(profiles: StoredProfile[]): void {
    if (typeof localStorage === "undefined") return

    try {
      localStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(profiles))
    } catch (error: unknown) {
      console.error("Failed to save profiles:", error)
      throw new Error("Failed to save profiles to storage")
    }
  }

  /**
   * Get profile by public key
   */
  static getProfileByPublicKey(publicKey: string): StoredProfile | null {
    if (!publicKey) return null
    const profiles: StoredProfile[] = this.getProfiles()
    // Normalize to lowercase for comparison (profiles store lowercase)
    const normalizedKey: string = publicKey.toLowerCase()
    return (
      profiles.find((p: StoredProfile): boolean => p.publicKey === normalizedKey) || null
    )
  }

  /**
   * Alias for getProfileByPublicKey (used in some places)
   */
  static loadProfile(publicKey: string): StoredProfile | null {
    return this.getProfileByPublicKey(publicKey)
  }

  /**
   * Get profile by ID
   */
  static getProfileById(id: string): StoredProfile | null {
    const profiles: StoredProfile[] = this.getProfiles()
    return profiles.find((p: StoredProfile): boolean => p.id === id) || null
  }

  /**
   * Get active profile ID
   */
  static getActiveProfileId(): string | null {
    if (typeof localStorage === "undefined") return null
    return localStorage.getItem(ACTIVE_PROFILE_KEY)
  }

  /**
   * Set active profile
   */
  static setActiveProfile(profileId: string): void {
    if (typeof localStorage === "undefined") return
    localStorage.setItem(ACTIVE_PROFILE_KEY, profileId)
  }

  /**
   * Get active profile
   */
  static getActiveProfile(): StoredProfile | null {
    const activeId: string | null = this.getActiveProfileId()
    if (!activeId) return null
    return this.getProfileById(activeId)
  }

  /**
   * Create a new profile
   */
  static createProfile(publicKey: string, signInMethod: string): StoredProfile {
    // Check if profile already exists
    const existing: StoredProfile | null = this.getProfileByPublicKey(publicKey)
    if (existing) {
      // Update last login and return existing
      existing.lastLogin = Date.now()
      existing.signInMethod = signInMethod
      this.updateProfile(existing)
      return existing
    }

    const profile: StoredProfile = {
      id: CryptoUtils.generateId(),
      publicKey: publicKey.toLowerCase(),
      signInMethod,
      createdAt: Date.now(),
      lastLogin: Date.now(),
      blinkAccounts: [],
      nwcConnections: [],
      tippingSettings: {
        enabled: true,
        defaultPercentages: [10, 15, 20],
        customAmountEnabled: true,
        forwardToNWC: false,
        forwardNWCId: null,
      },
      preferences: {
        defaultCurrency: "BTC",
        darkMode: true,
        sounds: true,
        language: "en",
        numberFormat: "auto", // Use browser locale by default
      },
    }

    const profiles: StoredProfile[] = this.getProfiles()
    profiles.push(profile)
    this.saveProfiles(profiles)
    this.setActiveProfile(profile.id)

    return profile
  }

  /**
   * Update an existing profile
   */
  static updateProfile(profile: StoredProfile): void {
    const profiles: StoredProfile[] = this.getProfiles()
    const index: number = profiles.findIndex(
      (p: StoredProfile): boolean => p.id === profile.id,
    )

    if (index === -1) {
      throw new Error("Profile not found")
    }

    profiles[index] = profile
    this.saveProfiles(profiles)
  }

  /**
   * Delete a profile
   */
  static deleteProfile(profileId: string): void {
    const profiles: StoredProfile[] = this.getProfiles()
    const filtered: StoredProfile[] = profiles.filter(
      (p: StoredProfile): boolean => p.id !== profileId,
    )
    this.saveProfiles(filtered)

    // Clear active profile if it was the deleted one
    if (this.getActiveProfileId() === profileId) {
      localStorage.removeItem(ACTIVE_PROFILE_KEY)
    }
  }

  // ============= Blink Account Management =============

  /**
   * Add a Blink account to a profile
   */
  static async addBlinkAccount(
    profileId: string,
    label: string,
    apiKey: string,
    username?: string,
    defaultCurrency?: string,
  ): Promise<StoredBlinkAccount> {
    const profile: StoredProfile | null = this.getProfileById(profileId)
    if (!profile) throw new Error("Profile not found")

    // Encrypt the API key
    const encryptedApiKey: EncryptedData = await CryptoUtils.encryptWithDeviceKey(apiKey)

    const account: StoredBlinkAccount = {
      id: CryptoUtils.generateId(),
      label,
      apiKey: encryptedApiKey,
      username,
      defaultCurrency,
      isActive: profile.blinkAccounts.length === 0, // First account is active
      createdAt: Date.now(),
      lastUsed: null,
    }

    profile.blinkAccounts.push(account)
    this.updateProfile(profile)

    return account
  }

  /**
   * Add a Blink account via Lightning Address (no API key)
   */
  static async addBlinkLnAddressAccount(
    profileId: string,
    { label, username, walletId, walletCurrency, lightningAddress }: BlinkLnAddressInput,
  ): Promise<StoredBlinkAccount> {
    const profile: StoredProfile | null = this.getProfileById(profileId)
    if (!profile) throw new Error("Profile not found")

    const account: StoredBlinkAccount = {
      id: CryptoUtils.generateId(),
      type: "ln-address", // Distinguishes from API key accounts
      label,
      username,
      walletId,
      walletCurrency,
      lightningAddress,
      defaultCurrency: walletCurrency === "USD" ? "USD" : "BTC",
      isActive: profile.blinkAccounts.length === 0, // First account is active
      createdAt: Date.now(),
      lastUsed: null,
    }

    profile.blinkAccounts.push(account)
    this.updateProfile(profile)

    return account
  }

  /**
   * Add npub.cash wallet to profile
   * npub.cash wallets receive payments as Cashu ecash tokens
   */
  static async addNpubCashAccount(
    profileId: string,
    { lightningAddress, label }: NpubCashInput,
  ): Promise<StoredBlinkAccount> {
    const profile: StoredProfile | null = this.getProfileById(profileId)
    if (!profile) throw new Error("Profile not found")

    // Check for duplicate Lightning Address
    const normalizedAddress: string = lightningAddress.toLowerCase().trim()
    const existingByAddress: StoredBlinkAccount | undefined = profile.blinkAccounts.find(
      (a: StoredBlinkAccount): boolean =>
        a.type === "npub-cash" && a.lightningAddress?.toLowerCase() === normalizedAddress,
    )
    if (existingByAddress) {
      throw new Error("This npub.cash address is already connected")
    }

    // Check for duplicate label among npub.cash wallets
    const normalizedLabel: string | undefined = label?.trim()
    if (normalizedLabel) {
      const existingByLabel: StoredBlinkAccount | undefined = profile.blinkAccounts.find(
        (a: StoredBlinkAccount): boolean =>
          a.type === "npub-cash" &&
          a.label?.toLowerCase() === normalizedLabel.toLowerCase(),
      )
      if (existingByLabel) {
        throw new Error("A wallet with this label already exists")
      }
    }

    // Parse the Lightning Address
    const [localpart]: string[] = lightningAddress.split("@")
    const isNpub: boolean = localpart.startsWith("npub1")

    const wallet: StoredBlinkAccount = {
      id: CryptoUtils.generateId(),
      type: "npub-cash", // Distinguishes from other wallet types
      label: normalizedLabel || lightningAddress,
      lightningAddress: normalizedAddress, // Full address like "npub1xxx@npub.cash"
      localpart, // Part before @ (npub or username)
      isNpub, // true if localpart is an npub
      defaultCurrency: "BTC", // npub.cash always uses sats
      isActive: profile.blinkAccounts.length === 0, // First wallet is active
      createdAt: Date.now(),
      lastUsed: null,
    }

    profile.blinkAccounts.push(wallet)
    this.updateProfile(profile)

    return wallet
  }

  /**
   * Get decrypted API key for a Blink account
   */
  static async getBlinkApiKey(
    profileId: string,
    accountId: string,
  ): Promise<string | null> {
    const profile: StoredProfile | null = this.getProfileById(profileId)
    if (!profile) throw new Error("Profile not found")

    const account: StoredBlinkAccount | undefined = profile.blinkAccounts.find(
      (a: StoredBlinkAccount): boolean => a.id === accountId,
    )
    if (!account) throw new Error("Account not found")

    // Lightning Address accounts don't have API keys
    if (account.type === "ln-address") {
      return null
    }

    return CryptoUtils.decryptWithDeviceKey(account.apiKey!)
  }

  /**
   * Get decrypted API key for the active Blink account
   */
  static async getActiveBlinkApiKey(profileId?: string): Promise<string | null> {
    const profile: StoredProfile | null = profileId
      ? this.getProfileById(profileId)
      : this.getActiveProfile()
    if (!profile) return null

    const activeAccount: StoredBlinkAccount | undefined = profile.blinkAccounts.find(
      (a: StoredBlinkAccount): boolean => a.isActive,
    )
    if (!activeAccount) return null

    // Lightning Address accounts don't have API keys
    if (activeAccount.type === "ln-address") {
      return null
    }

    return CryptoUtils.decryptWithDeviceKey(activeAccount.apiKey!)
  }

  /**
   * Set active Blink account
   */
  static setActiveBlinkAccount(profileId: string, accountId: string): void {
    const profile: StoredProfile | null = this.getProfileById(profileId)
    if (!profile) throw new Error("Profile not found")

    profile.blinkAccounts = profile.blinkAccounts.map(
      (account: StoredBlinkAccount): StoredBlinkAccount => ({
        ...account,
        isActive: account.id === accountId,
        lastUsed: account.id === accountId ? Date.now() : account.lastUsed,
      }),
    )

    this.updateProfile(profile)
  }

  /**
   * Update a Blink account
   */
  static async updateBlinkAccount(
    profileId: string,
    accountId: string,
    updates: Partial<StoredBlinkAccount> & { apiKey?: EncryptedData | string },
  ): Promise<void> {
    const profile: StoredProfile | null = this.getProfileById(profileId)
    if (!profile) throw new Error("Profile not found")

    const accountIndex: number = profile.blinkAccounts.findIndex(
      (a: StoredBlinkAccount): boolean => a.id === accountId,
    )
    if (accountIndex === -1) throw new Error("Account not found")

    // If updating API key, encrypt it
    if (updates.apiKey && typeof updates.apiKey === "string") {
      ;(updates as Record<string, unknown>).apiKey =
        await CryptoUtils.encryptWithDeviceKey(updates.apiKey)
    }

    profile.blinkAccounts[accountIndex] = {
      ...profile.blinkAccounts[accountIndex],
      ...updates,
    } as StoredBlinkAccount

    this.updateProfile(profile)
  }

  /**
   * Remove a Blink account
   */
  static removeBlinkAccount(profileId: string, accountId: string): void {
    const profile: StoredProfile | null = this.getProfileById(profileId)
    if (!profile) throw new Error("Profile not found")

    const wasActive: boolean | undefined = profile.blinkAccounts.find(
      (a: StoredBlinkAccount): boolean => a.id === accountId,
    )?.isActive
    profile.blinkAccounts = profile.blinkAccounts.filter(
      (a: StoredBlinkAccount): boolean => a.id !== accountId,
    )

    // If removed account was active, make first remaining account active
    if (wasActive && profile.blinkAccounts.length > 0) {
      profile.blinkAccounts[0].isActive = true
    }

    this.updateProfile(profile)
  }

  // ============= NWC Connection Management =============

  /**
   * Add an NWC connection to a profile
   */
  static async addNWCConnection(
    profileId: string,
    label: string,
    uri: string,
    capabilities: string[] = [],
  ): Promise<StoredNWCConnection> {
    const profile: StoredProfile | null = this.getProfileById(profileId)
    if (!profile) throw new Error("Profile not found")

    // Encrypt the URI
    const encryptedUri: EncryptedData = await CryptoUtils.encryptWithDeviceKey(uri)

    const connection: StoredNWCConnection = {
      id: CryptoUtils.generateId(),
      label,
      uri: encryptedUri,
      capabilities,
      isActive: profile.nwcConnections.length === 0,
      createdAt: Date.now(),
    }

    profile.nwcConnections.push(connection)
    this.updateProfile(profile)

    return connection
  }

  /**
   * Get decrypted NWC URI
   */
  static async getNWCUri(profileId: string, connectionId: string): Promise<string> {
    const profile: StoredProfile | null = this.getProfileById(profileId)
    if (!profile) throw new Error("Profile not found")

    const connection: StoredNWCConnection | undefined = profile.nwcConnections.find(
      (c: StoredNWCConnection): boolean => c.id === connectionId,
    )
    if (!connection) throw new Error("Connection not found")

    return CryptoUtils.decryptWithDeviceKey(connection.uri)
  }

  /**
   * Get active NWC connection URI
   */
  static async getActiveNWCUri(profileId?: string): Promise<string | null> {
    const profile: StoredProfile | null = profileId
      ? this.getProfileById(profileId)
      : this.getActiveProfile()
    if (!profile) return null

    const activeConnection: StoredNWCConnection | undefined = profile.nwcConnections.find(
      (c: StoredNWCConnection): boolean => c.isActive,
    )
    if (!activeConnection) return null

    return CryptoUtils.decryptWithDeviceKey(activeConnection.uri)
  }

  /**
   * Set active NWC connection
   */
  static setActiveNWCConnection(profileId: string, connectionId: string): void {
    const profile: StoredProfile | null = this.getProfileById(profileId)
    if (!profile) throw new Error("Profile not found")

    profile.nwcConnections = profile.nwcConnections.map(
      (conn: StoredNWCConnection): StoredNWCConnection => ({
        ...conn,
        isActive: conn.id === connectionId,
      }),
    )

    this.updateProfile(profile)
  }

  /**
   * Remove an NWC connection
   */
  static removeNWCConnection(profileId: string, connectionId: string): void {
    const profile: StoredProfile | null = this.getProfileById(profileId)
    if (!profile) throw new Error("Profile not found")

    const wasActive: boolean | undefined = profile.nwcConnections.find(
      (c: StoredNWCConnection): boolean => c.id === connectionId,
    )?.isActive
    profile.nwcConnections = profile.nwcConnections.filter(
      (c: StoredNWCConnection): boolean => c.id !== connectionId,
    )

    // If removed was active, make first remaining active
    if (wasActive && profile.nwcConnections.length > 0) {
      profile.nwcConnections[0].isActive = true
    }

    // Clear forward settings if this was the forwarding target
    if (profile.tippingSettings.forwardNWCId === connectionId) {
      profile.tippingSettings.forwardToNWC = false
      profile.tippingSettings.forwardNWCId = null
    }

    this.updateProfile(profile)
  }

  // ============= Settings Management =============

  /**
   * Update tipping settings
   */
  static updateTippingSettings(
    profileId: string,
    settings: Partial<StoredTippingSettings>,
  ): void {
    const profile: StoredProfile | null = this.getProfileById(profileId)
    if (!profile) throw new Error("Profile not found")

    profile.tippingSettings = {
      ...profile.tippingSettings,
      ...settings,
    }

    this.updateProfile(profile)
  }

  /**
   * Update preferences
   */
  static updatePreferences(
    profileId: string,
    preferences: Partial<StoredPreferences>,
  ): void {
    const profile: StoredProfile | null = this.getProfileById(profileId)
    if (!profile) throw new Error("Profile not found")

    profile.preferences = {
      ...profile.preferences,
      ...preferences,
    }

    this.updateProfile(profile)
  }

  // ============= Export/Import =============

  /**
   * Export profile data (for backup)
   * Note: Encrypted fields remain encrypted
   */
  static exportProfile(profileId: string): ProfileExportData {
    const profile: StoredProfile | null = this.getProfileById(profileId)
    if (!profile) throw new Error("Profile not found")

    return {
      version: 1,
      exportedAt: Date.now(),
      profile: {
        ...profile,
        // Remove device-specific encryption markers
        // User will need to re-add accounts on new device
      },
    }
  }

  /**
   * Export all profiles
   */
  static exportAllProfiles(): ProfileExportData {
    const profiles: StoredProfile[] = this.getProfiles()

    return {
      version: 1,
      exportedAt: Date.now(),
      profiles,
      activeProfileId: this.getActiveProfileId() || undefined,
    }
  }

  /**
   * Import profiles from backup
   * Note: Credentials will need to be re-added as they're device-encrypted
   */
  static importProfiles(data: ProfileExportData, merge: boolean = true): void {
    if (data.version !== 1) {
      throw new Error("Unsupported backup version")
    }

    const importedProfiles: StoredProfile[] =
      data.profiles ||
      [data.profile].filter((p: StoredProfile | undefined): p is StoredProfile =>
        Boolean(p),
      )

    if (merge) {
      const existing: StoredProfile[] = this.getProfiles()

      importedProfiles.forEach((imported: StoredProfile): void => {
        const normalizedImportKey: string = (imported.publicKey || "").toLowerCase()
        const existingIndex: number = existing.findIndex(
          (e: StoredProfile): boolean => e.publicKey === normalizedImportKey,
        )

        if (existingIndex >= 0) {
          // Merge: keep existing encrypted data, update settings
          existing[existingIndex] = {
            ...existing[existingIndex],
            tippingSettings: imported.tippingSettings,
            preferences: imported.preferences,
            // Keep existing blinkAccounts and nwcConnections
          }
        } else {
          // Add new profile (without credentials - they need re-adding)
          existing.push({
            ...imported,
            blinkAccounts: [],
            nwcConnections: [],
            id: CryptoUtils.generateId(),
          })
        }
      })

      this.saveProfiles(existing)
    } else {
      // Replace all (credentials will be lost)
      const cleaned: StoredProfile[] = importedProfiles.map(
        (p: StoredProfile): StoredProfile => ({
          ...p,
          blinkAccounts: [],
          nwcConnections: [],
          id: CryptoUtils.generateId(),
        }),
      )

      this.saveProfiles(cleaned)
    }

    // Restore active profile if it exists
    if (data.activeProfileId) {
      const profiles: StoredProfile[] = this.getProfiles()
      const importedActiveKey: string | undefined = (data.profiles || [])
        .find((dp: StoredProfile): boolean => dp.id === data.activeProfileId)
        ?.publicKey?.toLowerCase()
      const activeProfile: StoredProfile | undefined = profiles.find(
        (p: StoredProfile): boolean => p.publicKey === importedActiveKey,
      )
      if (activeProfile) {
        this.setActiveProfile(activeProfile.id)
      }
    }
  }

  // ============= Utility Methods =============

  /**
   * Check if user has any profiles
   */
  static hasProfiles(): boolean {
    return this.getProfiles().length > 0
  }

  /**
   * Get active Blink account info (without decrypting API key)
   */
  static getActiveBlinkAccount(): StoredBlinkAccount | null {
    const profile: StoredProfile | null = this.getActiveProfile()
    if (!profile) return null
    return (
      profile.blinkAccounts.find((a: StoredBlinkAccount): boolean => a.isActive) || null
    )
  }

  /**
   * Get active NWC connection info (without decrypting URI)
   */
  static getActiveNWCConnection(): StoredNWCConnection | null {
    const profile: StoredProfile | null = this.getActiveProfile()
    if (!profile) return null
    return (
      profile.nwcConnections.find((c: StoredNWCConnection): boolean => c.isActive) || null
    )
  }

  /**
   * Clear all profiles and data
   */
  static clearAll(): void {
    if (typeof localStorage === "undefined") return
    localStorage.removeItem(PROFILES_STORAGE_KEY)
    localStorage.removeItem(ACTIVE_PROFILE_KEY)
  }

  /**
   * Get storage size in bytes
   */
  static getStorageSize(): number {
    if (typeof localStorage === "undefined") return 0

    const profiles: string = localStorage.getItem(PROFILES_STORAGE_KEY) || ""
    return profiles.length * 2 // Rough estimate (UTF-16)
  }
}

// For ES modules
export default ProfileStorage
export { ProfileStorage }
