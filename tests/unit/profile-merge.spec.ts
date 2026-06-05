/**
 * Tests for the server-authoritative cross-device profile merge.
 *
 * These cover the three behaviors that fix the "different wallets on each
 * device" bug:
 *   1. server-only items are adopted locally (a fresh device gains the wallets
 *      another device added),
 *   2. deletions propagate (an item previously pulled from the server, now
 *      absent server-side, is dropped),
 *   3. locally-created items not yet on the server are kept and flagged for
 *      push-up; NWC connections are merged (no longer device-local only).
 *
 * The race-condition guard (non-authoritative reads must not sync up) is a
 * caller responsibility in useProfile.loadProfileData and is verified by code
 * review: mergeProfileData is only invoked for authoritative reads.
 */

import {
  mergeProfileData,
  pushLocalOnlyToServer,
  type MergeableAccount,
  type MergeResult,
  type ServerData,
  type SyncPushers,
} from "../../lib/hooks/profileMerge"
import type { EncryptedData } from "../../lib/storage/CryptoUtils"
import type { StoredNWCConnection } from "../../lib/storage/ProfileStorage"

// Fake device-key encryption: wraps plaintext in a recognizable shape so tests
// can assert "this came from the server and was re-encrypted for this device".
const fakeEncrypt = async (plaintext: string): Promise<EncryptedData> =>
  ({ __enc: plaintext }) as unknown as EncryptedData

const emptyServer = (): ServerData => ({
  blinkApiAccounts: [],
  blinkLnAddressWallets: [],
  npubCashWallets: [],
  nwcConnections: [],
})

describe("mergeProfileData (server-authoritative)", () => {
  it("adopts a server-only API account onto a device that has none", async () => {
    const server = emptyServer()
    server.blinkApiAccounts = [
      {
        id: "srv-1",
        label: "Shop",
        username: "shop",
        apiKey: "blink_plain_key",
        defaultCurrency: "BTC",
        isActive: true,
        createdAt: new Date().toISOString(),
      },
    ]

    const result = await mergeProfileData({
      localAccounts: [],
      localNwcConnections: [],
      server,
      encryptWithDeviceKey: fakeEncrypt,
    })

    expect(result.mergedAccounts).toHaveLength(1)
    expect(result.mergedAccounts[0].id).toBe("srv-1")
    expect(result.mergedAccounts[0].source).toBe("server")
    // API key was re-encrypted for this device, not stored as plaintext.
    expect(result.mergedAccounts[0].apiKey).toEqual({ __enc: "blink_plain_key" })
    expect(result.mergedAccounts[0].isActive).toBe(true)
    expect(result.needsLocalUpdate).toBe(true)
    // Nothing local-only to push up.
    expect(result.needsServerSyncApi).toBe(false)
  })

  it("drops a previously-server item that was deleted on another device", async () => {
    // Local has an item marked source:server, but the server no longer has it.
    const local: MergeableAccount[] = [
      {
        id: "ln-1",
        type: "ln-address",
        label: "Tips",
        username: "tips",
        lightningAddress: "tips@blink.sv",
        isActive: true,
        source: "server",
      },
    ]

    const result = await mergeProfileData({
      localAccounts: local,
      localNwcConnections: [],
      server: emptyServer(),
      encryptWithDeviceKey: fakeEncrypt,
    })

    // Deleted elsewhere -> removed locally, not re-pushed.
    expect(result.mergedAccounts).toHaveLength(0)
    expect(result.needsLocalUpdate).toBe(true)
    expect(result.needsServerSyncLnAddr).toBe(false)
  })

  it("keeps a locally-created item (no source flag) and flags it for push-up", async () => {
    const local: MergeableAccount[] = [
      {
        id: "ln-new",
        type: "ln-address",
        label: "New Tips",
        username: "newtips",
        lightningAddress: "newtips@blink.sv",
        isActive: true,
        // no source: created on this device, not yet synced
      },
    ]

    const result = await mergeProfileData({
      localAccounts: local,
      localNwcConnections: [],
      server: emptyServer(),
      encryptWithDeviceKey: fakeEncrypt,
    })

    expect(result.mergedAccounts).toHaveLength(1)
    expect(result.mergedAccounts[0].id).toBe("ln-new")
    expect(result.needsServerSyncLnAddr).toBe(true)
  })

  it("keeps the device-local copy when an item exists on both sides", async () => {
    const local: MergeableAccount[] = [
      {
        id: "srv-1",
        label: "Shop",
        username: "shop",
        apiKey: { __enc: "local_device_key" } as unknown as EncryptedData,
        isActive: true,
        source: "server",
      },
    ]
    const server = emptyServer()
    server.blinkApiAccounts = [
      {
        id: "srv-1",
        label: "Shop",
        username: "shop",
        apiKey: "blink_plain_key",
        isActive: true,
        createdAt: new Date().toISOString(),
      },
    ]

    const result = await mergeProfileData({
      localAccounts: local,
      localNwcConnections: [],
      server,
      encryptWithDeviceKey: fakeEncrypt,
    })

    expect(result.mergedAccounts).toHaveLength(1)
    // Keeps the existing device-encrypted key (not re-encrypted from server).
    expect(result.mergedAccounts[0].apiKey).toEqual({ __enc: "local_device_key" })
    expect(result.needsServerSyncApi).toBe(false)
  })

  it("marks an unmarked local item as server-backed when it exists on the server", async () => {
    // The device CREATED this wallet (no source flag) and it has since synced,
    // so the server now has it too. After an authoritative merge the local copy
    // must be stamped source:"server" and the localStorage update flagged.
    const local: MergeableAccount[] = [
      {
        id: "ln-mine",
        type: "ln-address",
        label: "Mine",
        username: "mine",
        lightningAddress: "mine@blink.sv",
        isActive: true,
        // no source: created locally, already synced
      },
    ]
    const server = emptyServer()
    server.blinkLnAddressWallets = [
      {
        id: "ln-mine",
        label: "Mine",
        username: "mine",
        lightningAddress: "mine@blink.sv",
        isActive: true,
        createdAt: new Date().toISOString(),
      },
    ]

    const result = await mergeProfileData({
      localAccounts: local,
      localNwcConnections: [],
      server,
      encryptWithDeviceKey: fakeEncrypt,
    })

    expect(result.mergedAccounts).toHaveLength(1)
    expect(result.mergedAccounts[0].source).toBe("server")
    expect(result.needsLocalUpdate).toBe(true)
    expect(result.needsServerSyncLnAddr).toBe(false)
  })

  it("drops (not re-syncs) a locally-created item after it disappears from the server", async () => {
    // Regression for the originating-device deletion bug: a wallet created on
    // this device, synced (so it gets stamped server-backed on the first
    // authoritative merge), is then deleted on another device. On the next
    // merge the server no longer has it and it must be DROPPED, not re-pushed.

    // Pass 1: unmarked local item present on the server -> stamped server-backed.
    const pass1Local: MergeableAccount[] = [
      {
        id: "ln-mine",
        type: "ln-address",
        label: "Mine",
        username: "mine",
        lightningAddress: "mine@blink.sv",
        isActive: true,
      },
    ]
    const serverWithItem = emptyServer()
    serverWithItem.blinkLnAddressWallets = [
      {
        id: "ln-mine",
        label: "Mine",
        username: "mine",
        lightningAddress: "mine@blink.sv",
        isActive: true,
        createdAt: new Date().toISOString(),
      },
    ]

    const pass1 = await mergeProfileData({
      localAccounts: pass1Local,
      localNwcConnections: [],
      server: serverWithItem,
      encryptWithDeviceKey: fakeEncrypt,
    })
    expect(pass1.mergedAccounts[0].source).toBe("server")

    // Pass 2: feed pass-1 output back as local state; server has dropped it.
    const pass2 = await mergeProfileData({
      localAccounts: pass1.mergedAccounts,
      localNwcConnections: [],
      server: emptyServer(),
      encryptWithDeviceKey: fakeEncrypt,
    })

    expect(pass2.mergedAccounts).toHaveLength(0)
    expect(pass2.needsServerSyncLnAddr).toBe(false)
    expect(pass2.needsLocalUpdate).toBe(true)
  })

  it("adopts a server-only NWC connection and re-encrypts its URI", async () => {
    const server = emptyServer()
    server.nwcConnections = [
      {
        id: "nwc-1",
        label: "Alby",
        uri: "nostr+walletconnect://abc?relay=wss://r&secret=s",
        capabilities: ["pay_invoice"],
        isActive: true,
        createdAt: 123,
      } as unknown as StoredNWCConnection,
    ]

    const result = await mergeProfileData({
      localAccounts: [],
      localNwcConnections: [],
      server,
      encryptWithDeviceKey: fakeEncrypt,
    })

    expect(result.mergedNwcConnections).toHaveLength(1)
    expect(result.mergedNwcConnections[0].id).toBe("nwc-1")
    expect(result.mergedNwcConnections[0].uri).toEqual({
      __enc: "nostr+walletconnect://abc?relay=wss://r&secret=s",
    })
    // First connection becomes active.
    expect(result.mergedNwcConnections[0].isActive).toBe(true)
    expect(result.needsLocalUpdate).toBe(true)
  })

  it("keeps a local-only NWC connection and flags it for push-up", async () => {
    const local: StoredNWCConnection[] = [
      {
        id: "nwc-local",
        label: "Mutiny",
        uri: { __enc: "device_uri" } as unknown as EncryptedData,
        capabilities: [],
        isActive: true,
        createdAt: 1,
      },
    ]

    const result = await mergeProfileData({
      localAccounts: [],
      localNwcConnections: local,
      server: emptyServer(),
      encryptWithDeviceKey: fakeEncrypt,
    })

    expect(result.mergedNwcConnections).toHaveLength(1)
    expect(result.mergedNwcConnections[0].id).toBe("nwc-local")
    expect(result.needsServerSyncNwc).toBe(true)
  })

  it("re-elects an active account when the active one was deleted elsewhere", async () => {
    // The active item came from the server and is now gone; a local-only item
    // remains and should be promoted to active.
    const local: MergeableAccount[] = [
      {
        id: "gone",
        type: "ln-address",
        label: "Gone",
        lightningAddress: "gone@blink.sv",
        isActive: true,
        source: "server",
      },
      {
        id: "kept",
        type: "ln-address",
        label: "Kept",
        lightningAddress: "kept@blink.sv",
        isActive: false,
        // local-only, kept
      },
    ]

    const result = await mergeProfileData({
      localAccounts: local,
      localNwcConnections: [],
      server: emptyServer(),
      encryptWithDeviceKey: fakeEncrypt,
    })

    expect(result.mergedAccounts).toHaveLength(1)
    expect(result.mergedAccounts[0].id).toBe("kept")
    expect(result.mergedAccounts[0].isActive).toBe(true)
  })

  it("returns empty, no-sync result when both sides are empty", async () => {
    const result = await mergeProfileData({
      localAccounts: [],
      localNwcConnections: [],
      server: emptyServer(),
      encryptWithDeviceKey: fakeEncrypt,
    })

    expect(result.mergedAccounts).toHaveLength(0)
    expect(result.mergedNwcConnections).toHaveLength(0)
    expect(result.needsLocalUpdate).toBe(false)
    expect(result.needsServerSyncApi).toBe(false)
    expect(result.needsServerSyncLnAddr).toBe(false)
    expect(result.needsServerSyncNpubCash).toBe(false)
    expect(result.needsServerSyncNwc).toBe(false)
  })
})

describe("pushLocalOnlyToServer", () => {
  const basePlan = (overrides: Partial<MergeResult>): MergeResult => ({
    mergedAccounts: [],
    mergedNwcConnections: [],
    needsLocalUpdate: false,
    needsServerSyncApi: false,
    needsServerSyncLnAddr: false,
    needsServerSyncNpubCash: false,
    needsServerSyncNwc: false,
    ...overrides,
  })

  const makePushers = (): { pushers: SyncPushers; calls: string[] } => {
    const calls: string[] = []
    const pushers: SyncPushers = {
      pushApi: async () => {
        calls.push("api")
      },
      pushLnAddr: async () => {
        calls.push("lnAddr")
      },
      pushNpubCash: async () => {
        calls.push("npubCash")
      },
      pushNwc: async () => {
        calls.push("nwc")
      },
    }
    return { pushers, calls }
  }

  it("writes ALL flagged categories (mixed local-only profile)", async () => {
    // Regression: previously the debounced helpers shared one timer and
    // cancelled each other, so only the last category was persisted.
    const { pushers, calls } = makePushers()
    const plan = basePlan({
      needsServerSyncApi: true,
      needsServerSyncLnAddr: true,
    })

    await pushLocalOnlyToServer(plan, pushers)

    expect(calls).toEqual(["api", "lnAddr"])
  })

  it("writes every category when all four are flagged", async () => {
    const { pushers, calls } = makePushers()
    const plan = basePlan({
      needsServerSyncApi: true,
      needsServerSyncLnAddr: true,
      needsServerSyncNpubCash: true,
      needsServerSyncNwc: true,
    })

    await pushLocalOnlyToServer(plan, pushers)

    expect(calls).toEqual(["api", "lnAddr", "npubCash", "nwc"])
  })

  it("pushes nothing when no category is flagged", async () => {
    const { pushers, calls } = makePushers()
    await pushLocalOnlyToServer(basePlan({}), pushers)
    expect(calls).toEqual([])
  })

  it("awaits each push to completion before starting the next", async () => {
    // Prove sequencing: a slow first push still completes before the second
    // starts, so neither can be lost to a shared-timer cancellation.
    const order: string[] = []
    const pushers: SyncPushers = {
      pushApi: async () => {
        await new Promise((r) => setTimeout(r, 10))
        order.push("api-done")
      },
      pushLnAddr: async () => {
        order.push("lnAddr-start")
      },
      pushNpubCash: async () => {},
      pushNwc: async () => {},
    }

    await pushLocalOnlyToServer(
      basePlan({ needsServerSyncApi: true, needsServerSyncLnAddr: true }),
      pushers,
    )

    expect(order).toEqual(["api-done", "lnAddr-start"])
  })
})
