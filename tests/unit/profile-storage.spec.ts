/**
 * Unit Tests for lib/storage/ProfileStorage.js
 *
 * Tests profile management, account storage, and settings.
 */

// We need to load this module dynamically due to mixed exports
import type {
  ProfileExportData,
  ProfileStorage as ProfileStorageClass,
  StoredProfile,
} from "../../lib/storage/ProfileStorage"

let ProfileStorage: typeof ProfileStorageClass

beforeAll(async () => {
  // Dynamically import to avoid module system conflicts
  const mod = await import("../../lib/storage/ProfileStorage")
  ProfileStorage = (mod.default ||
    mod.ProfileStorage ||
    mod) as typeof ProfileStorageClass
})

describe("ProfileStorage", () => {
  beforeEach(() => {
    localStorage.clear()
    jest.clearAllMocks()
  })

  describe("Profile CRUD Operations", () => {
    describe("getProfiles()", () => {
      it("should return empty array when no profiles exist", () => {
        const profiles = ProfileStorage.getProfiles()
        expect(profiles).toEqual([])
      })

      it("should return stored profiles", () => {
        const mockProfiles = [{ id: "1", publicKey: "abc123", signInMethod: "extension" }]
        localStorage.setItem("blinkpos_profiles", JSON.stringify(mockProfiles))

        const profiles = ProfileStorage.getProfiles()
        expect(profiles).toEqual(mockProfiles)
      })

      it("should return empty array on parse error", () => {
        localStorage.setItem("blinkpos_profiles", "invalid json")

        const profiles = ProfileStorage.getProfiles()
        expect(profiles).toEqual([])
      })
    })

    describe("saveProfiles()", () => {
      it("should save profiles to localStorage", () => {
        const profiles = [{ id: "1", publicKey: "abc" }]

        ProfileStorage.saveProfiles(profiles as unknown as StoredProfile[])

        const stored = JSON.parse(localStorage.getItem("blinkpos_profiles") || "[]")
        expect(stored).toEqual(profiles)
      })
    })

    describe("createProfile()", () => {
      it("should create a new profile", () => {
        const profile = ProfileStorage.createProfile("abc123def", "extension")

        expect(profile).toBeDefined()
        expect(profile.publicKey).toBe("abc123def")
        expect(profile.signInMethod).toBe("extension")
        expect(profile.id).toBeDefined()
        expect(profile.createdAt).toBeDefined()
        expect(profile.lastLogin).toBeDefined()
        expect(profile.blinkAccounts).toEqual([])
        expect(profile.nwcConnections).toEqual([])
      })

      it("should normalize public key to lowercase", () => {
        const profile = ProfileStorage.createProfile("ABC123DEF", "extension")

        expect(profile.publicKey).toBe("abc123def")
      })

      it("should set as active profile", () => {
        const profile = ProfileStorage.createProfile("abc123", "extension")

        expect(ProfileStorage.getActiveProfileId()).toBe(profile.id)
      })

      it("should return existing profile if public key matches", () => {
        const profile1 = ProfileStorage.createProfile("abc123", "extension")
        const profile2 = ProfileStorage.createProfile("abc123", "externalSigner")

        expect(profile2.id).toBe(profile1.id)
        expect(profile2.signInMethod).toBe("externalSigner") // Updated
      })

      it("should initialize with default settings", () => {
        const profile = ProfileStorage.createProfile("abc123", "extension")

        expect(profile.tippingSettings.enabled).toBe(true)
        expect(profile.tippingSettings.defaultPercentages).toEqual([10, 15, 20])
        expect(profile.preferences.darkMode).toBe(true)
        expect(profile.preferences.sounds).toBe(true)
        expect(profile.preferences.defaultCurrency).toBe("BTC")
      })
    })

    describe("getProfileByPublicKey()", () => {
      it("should find profile by public key", () => {
        ProfileStorage.createProfile("abc123", "extension")

        const found = ProfileStorage.getProfileByPublicKey("abc123")

        expect(found).toBeDefined()
        expect(found!.publicKey).toBe("abc123")
      })

      it("should handle case-insensitive lookup", () => {
        ProfileStorage.createProfile("abc123", "extension")

        const found = ProfileStorage.getProfileByPublicKey("ABC123")

        expect(found).toBeDefined()
      })

      it("should return null for non-existent public key", () => {
        const found = ProfileStorage.getProfileByPublicKey("nonexistent")

        expect(found).toBeNull()
      })

      it("should return null for null/undefined input", () => {
        expect(ProfileStorage.getProfileByPublicKey(null)).toBeNull()
        expect(ProfileStorage.getProfileByPublicKey(undefined)).toBeNull()
      })
    })

    describe("getProfileById()", () => {
      it("should find profile by ID", () => {
        const created = ProfileStorage.createProfile("abc123", "extension")

        const found = ProfileStorage.getProfileById(created.id)

        expect(found).toBeDefined()
        expect(found!.id).toBe(created.id)
      })

      it("should return null for non-existent ID", () => {
        const found = ProfileStorage.getProfileById("nonexistent")

        expect(found).toBeNull()
      })
    })

    describe("updateProfile()", () => {
      it("should update existing profile", () => {
        const profile = ProfileStorage.createProfile("abc123", "extension")
        profile.preferences.darkMode = false

        ProfileStorage.updateProfile(profile)

        const updated = ProfileStorage.getProfileById(profile.id)
        expect(updated!.preferences.darkMode).toBe(false)
      })

      it("should throw for non-existent profile", () => {
        expect(() => {
          // Runtime only reads .id before throwing "Profile not found"
          ProfileStorage.updateProfile({ id: "nonexistent" } as StoredProfile)
        }).toThrow("Profile not found")
      })
    })

    describe("deleteProfile()", () => {
      it("should delete profile", () => {
        const profile = ProfileStorage.createProfile("abc123", "extension")

        ProfileStorage.deleteProfile(profile.id)

        expect(ProfileStorage.getProfileById(profile.id)).toBeNull()
      })

      it("should clear active profile if deleted", () => {
        const profile = ProfileStorage.createProfile("abc123", "extension")

        ProfileStorage.deleteProfile(profile.id)

        expect(ProfileStorage.getActiveProfileId()).toBeNull()
      })
    })
  })

  describe("Active Profile Management", () => {
    describe("getActiveProfileId() / setActiveProfile()", () => {
      it("should get and set active profile ID", () => {
        const profile = ProfileStorage.createProfile("abc123", "extension")

        ProfileStorage.setActiveProfile(profile.id)

        expect(ProfileStorage.getActiveProfileId()).toBe(profile.id)
      })
    })

    describe("getActiveProfile()", () => {
      it("should return active profile", () => {
        const profile = ProfileStorage.createProfile("abc123", "extension")

        const active = ProfileStorage.getActiveProfile()

        expect(active!.id).toBe(profile.id)
      })

      it("should return null when no active profile", () => {
        expect(ProfileStorage.getActiveProfile()).toBeNull()
      })
    })
  })

  describe("Blink Account Management", () => {
    let profileId: string

    beforeEach(() => {
      const profile = ProfileStorage.createProfile("abc123", "extension")
      profileId = profile.id
    })

    describe("addBlinkAccount()", () => {
      it("should add a Blink account with encrypted API key", async () => {
        const account = await ProfileStorage.addBlinkAccount(
          profileId,
          "My Account",
          "api-key-123",
          "testuser",
          "USD",
        )

        expect(account).toBeDefined()
        expect(account.label).toBe("My Account")
        expect(account.username).toBe("testuser")
        expect(account.defaultCurrency).toBe("USD")
        expect(account.apiKey).toHaveProperty("encrypted")
        expect(account.isActive).toBe(true) // First account is active
      })

      it("should set subsequent accounts as inactive", async () => {
        await ProfileStorage.addBlinkAccount(profileId, "First", "key1")
        const second = await ProfileStorage.addBlinkAccount(profileId, "Second", "key2")

        expect(second.isActive).toBe(false)
      })

      it("should throw for non-existent profile", async () => {
        await expect(
          ProfileStorage.addBlinkAccount("nonexistent", "Label", "key"),
        ).rejects.toThrow("Profile not found")
      })
    })

    describe("addBlinkLnAddressAccount()", () => {
      it("should add a Lightning Address account", async () => {
        const account = await ProfileStorage.addBlinkLnAddressAccount(profileId, {
          label: "LN Account",
          username: "testuser",
          walletId: "wallet-123",
          walletCurrency: "BTC",
          lightningAddress: "testuser@blink.sv",
        })

        expect(account.type).toBe("ln-address")
        expect(account.lightningAddress).toBe("testuser@blink.sv")
        expect(account.walletId).toBe("wallet-123")
      })
    })

    describe("addNpubCashAccount()", () => {
      it("should add an npub.cash account", async () => {
        const account = await ProfileStorage.addNpubCashAccount(profileId, {
          lightningAddress: "npub1abc@npub.cash",
          label: "My npub.cash",
        })

        expect(account.type).toBe("npub-cash")
        expect(account.lightningAddress).toBe("npub1abc@npub.cash")
        expect(account.isNpub).toBe(true)
      })

      it("should detect non-npub addresses", async () => {
        const account = await ProfileStorage.addNpubCashAccount(profileId, {
          lightningAddress: "username@npub.cash",
          label: "My npub.cash",
        })

        expect(account.isNpub).toBe(false)
      })

      it("should reject duplicate Lightning addresses", async () => {
        await ProfileStorage.addNpubCashAccount(profileId, {
          lightningAddress: "npub1abc@npub.cash",
          label: "First",
        })

        await expect(
          ProfileStorage.addNpubCashAccount(profileId, {
            lightningAddress: "npub1abc@npub.cash",
            label: "Second",
          }),
        ).rejects.toThrow("already connected")
      })
    })

    describe("setActiveBlinkAccount()", () => {
      it("should set active account and update lastUsed", async () => {
        await ProfileStorage.addBlinkAccount(profileId, "First", "key1")
        const second = await ProfileStorage.addBlinkAccount(profileId, "Second", "key2")

        ProfileStorage.setActiveBlinkAccount(profileId, second.id)

        const profile = ProfileStorage.getProfileById(profileId)
        const activeAccount = profile!.blinkAccounts.find(
          (a: { isActive: boolean; id: string; lastUsed?: unknown }) => a.isActive,
        )
        expect(activeAccount!.id).toBe(second.id)
        expect(activeAccount!.lastUsed).toBeDefined()
      })
    })

    describe("removeBlinkAccount()", () => {
      it("should remove account", async () => {
        const account = await ProfileStorage.addBlinkAccount(profileId, "Test", "key")

        ProfileStorage.removeBlinkAccount(profileId, account.id)

        const profile = ProfileStorage.getProfileById(profileId)
        expect(profile!.blinkAccounts).toHaveLength(0)
      })

      it("should make first remaining account active if active was removed", async () => {
        const first = await ProfileStorage.addBlinkAccount(profileId, "First", "key1")
        await ProfileStorage.addBlinkAccount(profileId, "Second", "key2")

        ProfileStorage.removeBlinkAccount(profileId, first.id)

        const profile = ProfileStorage.getProfileById(profileId)
        expect(profile!.blinkAccounts[0].isActive).toBe(true)
      })
    })

    describe("getActiveBlinkAccount()", () => {
      it("should return active account without decrypted key", async () => {
        await ProfileStorage.addBlinkAccount(profileId, "Test", "key")

        const active = ProfileStorage.getActiveBlinkAccount()

        expect(active).toBeDefined()
        expect(active!.label).toBe("Test")
        // apiKey should be encrypted object, not plain string
        expect(typeof active!.apiKey).toBe("object")
      })

      it("should return null when no active account", () => {
        expect(ProfileStorage.getActiveBlinkAccount()).toBeNull()
      })
    })
  })

  describe("NWC Connection Management", () => {
    let profileId: string

    beforeEach(() => {
      const profile = ProfileStorage.createProfile("abc123", "extension")
      profileId = profile.id
    })

    describe("addNWCConnection()", () => {
      it("should add an NWC connection with encrypted URI", async () => {
        const connection = await ProfileStorage.addNWCConnection(
          profileId,
          "My NWC",
          "nostr+walletconnect://...",
          ["pay_invoice", "get_balance"],
        )

        expect(connection).toBeDefined()
        expect(connection.label).toBe("My NWC")
        expect(connection.uri).toHaveProperty("encrypted")
        expect(connection.capabilities).toEqual(["pay_invoice", "get_balance"])
        expect(connection.isActive).toBe(true)
      })
    })

    describe("setActiveNWCConnection()", () => {
      it("should set active NWC connection", async () => {
        await ProfileStorage.addNWCConnection(profileId, "First", "uri1")
        const second = await ProfileStorage.addNWCConnection(profileId, "Second", "uri2")

        ProfileStorage.setActiveNWCConnection(profileId, second.id)

        const profile = ProfileStorage.getProfileById(profileId)
        const active = profile!.nwcConnections.find(
          (c: { isActive: boolean; id: string }) => c.isActive,
        )
        expect(active!.id).toBe(second.id)
      })
    })

    describe("removeNWCConnection()", () => {
      it("should remove NWC connection", async () => {
        const conn = await ProfileStorage.addNWCConnection(profileId, "Test", "uri")

        ProfileStorage.removeNWCConnection(profileId, conn.id)

        const profile = ProfileStorage.getProfileById(profileId)
        expect(profile!.nwcConnections).toHaveLength(0)
      })

      it("should clear forward settings if forwarding target removed", async () => {
        const conn = await ProfileStorage.addNWCConnection(profileId, "Forward", "uri")
        ProfileStorage.updateTippingSettings(profileId, {
          forwardToNWC: true,
          forwardNWCId: conn.id,
        })

        ProfileStorage.removeNWCConnection(profileId, conn.id)

        const profile = ProfileStorage.getProfileById(profileId)
        expect(profile!.tippingSettings.forwardToNWC).toBe(false)
        expect(profile!.tippingSettings.forwardNWCId).toBeNull()
      })
    })
  })

  describe("Settings Management", () => {
    let profileId: string

    beforeEach(() => {
      const profile = ProfileStorage.createProfile("abc123", "extension")
      profileId = profile.id
    })

    describe("updateTippingSettings()", () => {
      it("should update tipping settings", () => {
        ProfileStorage.updateTippingSettings(profileId, {
          enabled: false,
          defaultPercentages: [5, 10, 15],
        })

        const profile = ProfileStorage.getProfileById(profileId)
        expect(profile!.tippingSettings.enabled).toBe(false)
        expect(profile!.tippingSettings.defaultPercentages).toEqual([5, 10, 15])
        // Original values should be preserved
        expect(profile!.tippingSettings.customAmountEnabled).toBe(true)
      })
    })

    describe("updatePreferences()", () => {
      it("should update preferences", () => {
        ProfileStorage.updatePreferences(profileId, {
          darkMode: false,
          defaultCurrency: "USD",
        })

        const profile = ProfileStorage.getProfileById(profileId)
        expect(profile!.preferences.darkMode).toBe(false)
        expect(profile!.preferences.defaultCurrency).toBe("USD")
        // Original values should be preserved
        expect(profile!.preferences.sounds).toBe(true)
      })
    })
  })

  describe("Export/Import", () => {
    describe("exportProfile()", () => {
      it("should export profile data", () => {
        const profile = ProfileStorage.createProfile("abc123", "extension")

        const exported = ProfileStorage.exportProfile(profile.id)

        expect(exported.version).toBe(1)
        expect(exported.exportedAt).toBeDefined()
        expect(exported.profile!.publicKey).toBe("abc123")
      })

      it("should throw for non-existent profile", () => {
        expect(() => ProfileStorage.exportProfile("nonexistent")).toThrow(
          "Profile not found",
        )
      })
    })

    describe("exportAllProfiles()", () => {
      it("should export all profiles", () => {
        ProfileStorage.createProfile("abc", "extension")
        ProfileStorage.createProfile("def", "extension")

        const exported = ProfileStorage.exportAllProfiles()

        expect(exported.version).toBe(1)
        expect(exported.profiles).toHaveLength(2)
        expect(exported.activeProfileId).toBeDefined()
      })
    })

    describe("importProfiles()", () => {
      it("should import profiles with merge", () => {
        ProfileStorage.createProfile("existing", "extension")

        const importData = {
          version: 1,
          profiles: [{ publicKey: "newprofile", preferences: { darkMode: false } }],
        }

        // Import deliberately tolerates partial/untrusted backup payloads
        ProfileStorage.importProfiles(importData as unknown as ProfileExportData, true)

        const profiles = ProfileStorage.getProfiles()
        expect(profiles).toHaveLength(2)
      })

      it("should merge settings for existing profiles", () => {
        ProfileStorage.createProfile("abc123", "extension")

        const importData = {
          version: 1,
          profiles: [
            {
              publicKey: "abc123",
              preferences: { darkMode: false, defaultCurrency: "EUR" },
              tippingSettings: { enabled: false },
            },
          ],
        }

        ProfileStorage.importProfiles(importData as unknown as ProfileExportData, true)

        const profile = ProfileStorage.getProfileByPublicKey("abc123")
        expect(profile!.preferences.darkMode).toBe(false)
        expect(profile!.tippingSettings.enabled).toBe(false)
      })

      it("should throw for unsupported version", () => {
        expect(() =>
          ProfileStorage.importProfiles({
            version: 99,
            profiles: [],
          } as unknown as ProfileExportData),
        ).toThrow("Unsupported backup version")
      })
    })
  })

  describe("Utility Methods", () => {
    describe("hasProfiles()", () => {
      it("should return false when no profiles", () => {
        expect(ProfileStorage.hasProfiles()).toBe(false)
      })

      it("should return true when profiles exist", () => {
        ProfileStorage.createProfile("abc", "extension")
        expect(ProfileStorage.hasProfiles()).toBe(true)
      })
    })

    describe("clearAll()", () => {
      it("should clear all profiles and active profile", () => {
        ProfileStorage.createProfile("abc", "extension")

        ProfileStorage.clearAll()

        expect(ProfileStorage.getProfiles()).toEqual([])
        expect(ProfileStorage.getActiveProfileId()).toBeNull()
      })
    })

    describe("getStorageSize()", () => {
      it("should return storage size estimate", () => {
        ProfileStorage.createProfile("abc123", "extension")

        const size = ProfileStorage.getStorageSize()

        expect(size).toBeGreaterThan(0)
      })

      it("should return 0 when empty", () => {
        expect(ProfileStorage.getStorageSize()).toBe(0)
      })
    })
  })
})
