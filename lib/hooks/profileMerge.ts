/**
 * Pure, I/O-free merge logic for cross-device profile sync.
 *
 * This is intentionally separated from the `useProfile` hook so the merge
 * decisions can be unit-tested deterministically without React, network, or
 * crypto side effects. The hook owns all I/O (fetching, state updates,
 * localStorage writes, server PATCHes); this module only decides *what* the
 * merged result should be and *which* items still need to be pushed up.
 *
 * Merge model: SERVER-AUTHORITATIVE.
 *
 *   - A non-authoritative server read (session not ready / request failed) must
 *     NOT trigger any merge or sync-up — that is handled by the caller, which
 *     should skip calling this function entirely in that case.
 *   - On an authoritative read, the server is the source of truth: server items
 *     are adopted, and a local item that previously came from the server
 *     (`source === "server"`) but is now absent server-side is treated as
 *     DELETED elsewhere and dropped. A local item without that marker was
 *     created on this device and not yet synced, so it is kept and flagged for
 *     push-up. This propagates deletions while still surfacing brand-new local
 *     additions.
 */

import type { EncryptedData } from "../storage/CryptoUtils"
import type { StoredNWCConnection } from "../storage/ProfileStorage"

export interface ServerBlinkApiAccount {
  id: string
  label: string
  username?: string
  apiKey?: string
  defaultCurrency?: string
  isActive: boolean
  createdAt: string
  lastUsed?: string
}

export interface ServerLnAddressWallet {
  id: string
  label: string
  username?: string
  lightningAddress?: string
  walletId?: string
  isActive: boolean
  createdAt: string
  lastUsed?: string
}

export interface ServerNpubCashWallet {
  id: string
  label: string
  address?: string
  lightningAddress?: string
  localpart?: string
  isNpub?: boolean
  pubkey?: string
  isActive: boolean
  createdAt?: string
  lastUsed?: string
}

/**
 * NWC connection as returned by the sync GET: identical shape to
 * StoredNWCConnection except the `uri` is plaintext (decrypted by the server)
 * rather than device-encrypted.
 */
export interface ServerNWCConnection {
  id: string
  label: string
  uri: string
  capabilities?: string[]
  isActive?: boolean
  createdAt?: number
}

export interface MergeableAccount {
  id: string
  label: string
  apiKey?: EncryptedData
  username?: string
  defaultCurrency?: string
  isActive: boolean
  createdAt?: number | string
  lastUsed?: number | null
  type?: string
  lightningAddress?: string
  walletId?: string
  localpart?: string
  isNpub?: boolean
  pubkey?: string
  address?: string
  source?: string
}

export interface ServerData {
  blinkApiAccounts: ServerBlinkApiAccount[]
  blinkLnAddressWallets: ServerLnAddressWallet[]
  npubCashWallets: ServerNpubCashWallet[]
  nwcConnections: StoredNWCConnection[]
}

export interface MergeInput {
  localAccounts: MergeableAccount[]
  localNwcConnections: StoredNWCConnection[]
  server: ServerData
  /** Device-key encrypt function (injected so this stays pure/testable). */
  encryptWithDeviceKey: (plaintext: string) => Promise<EncryptedData>
}

export interface MergeResult {
  mergedAccounts: MergeableAccount[]
  mergedNwcConnections: StoredNWCConnection[]
  /** localStorage should be rewritten with the merged sets. */
  needsLocalUpdate: boolean
  /** Local-only items of each type that must be pushed to the server. */
  needsServerSyncApi: boolean
  needsServerSyncLnAddr: boolean
  needsServerSyncNpubCash: boolean
  needsServerSyncNwc: boolean
}

const isApiKeyAccount = (a: MergeableAccount): boolean =>
  a.type !== "ln-address" && a.type !== "npub-cash" && !!a.apiKey
const isLnAddress = (a: MergeableAccount): boolean => a.type === "ln-address"
const isNpubCash = (a: MergeableAccount): boolean => a.type === "npub-cash"
const wasFromServer = (a: MergeableAccount): boolean => a.source === "server"

/**
 * Result of reconciling a local item that also exists on the server during an
 * authoritative merge. The item is kept (the local copy carries the
 * device-encrypted secret) but stamped `source: "server"` so a later
 * disappearance from the server is correctly read as a remote DELETE rather
 * than a brand-new local addition that should be pushed back up.
 *
 * `changed` reports whether the marker was newly added, so the caller knows it
 * must persist the updated local record.
 */
function markServerBacked<T extends MergeableAccount>(
  local: T,
): {
  item: T
  changed: boolean
} {
  if (local.source === "server") return { item: local, changed: false }
  return { item: { ...local, source: "server" }, changed: true }
}

/**
 * Compute the server-authoritative merge of local + server profile data.
 *
 * The caller MUST only invoke this for an authoritative server read.
 */
export async function mergeProfileData(input: MergeInput): Promise<MergeResult> {
  const { localAccounts, localNwcConnections, server, encryptWithDeviceKey } = input

  const localApiKeyAccounts = localAccounts.filter(isApiKeyAccount)
  const localLnAddressWallets = localAccounts.filter(isLnAddress)
  const localNpubCashWallets = localAccounts.filter(isNpubCash)

  let needsLocalUpdate = false
  let needsServerSyncApi = false
  let needsServerSyncLnAddr = false
  let needsServerSyncNpubCash = false

  // === Blink API accounts ===
  const mergedApiAccounts: MergeableAccount[] = []
  for (const serverAccount of server.blinkApiAccounts) {
    const localAccount = localApiKeyAccounts.find(
      (l) => l.id === serverAccount.id || l.username === serverAccount.username,
    )
    if (localAccount) {
      // Exists on both sides — keep the local copy (it holds the device
      // encrypted API key) but mark it server-backed so a future delete on
      // another device propagates instead of being re-synced from here.
      const { item, changed } = markServerBacked(localAccount)
      mergedApiAccounts.push(item)
      if (changed) needsLocalUpdate = true
    } else if (serverAccount.apiKey) {
      try {
        const encryptedApiKey = await encryptWithDeviceKey(serverAccount.apiKey)
        mergedApiAccounts.push({
          id: serverAccount.id,
          label: serverAccount.label,
          username: serverAccount.username,
          apiKey: encryptedApiKey,
          defaultCurrency: serverAccount.defaultCurrency || "BTC",
          isActive: localAccounts.length === 0 && mergedApiAccounts.length === 0,
          createdAt: new Date(serverAccount.createdAt).getTime(),
          lastUsed: serverAccount.lastUsed
            ? new Date(serverAccount.lastUsed).getTime()
            : undefined,
          source: "server",
        })
        needsLocalUpdate = true
      } catch {
        // Skip accounts we cannot encrypt for this device.
      }
    }
  }
  for (const localAccount of localApiKeyAccounts) {
    const existsOnServer = server.blinkApiAccounts.find(
      (s) => s.id === localAccount.id || s.username === localAccount.username,
    )
    if (!existsOnServer) {
      if (wasFromServer(localAccount)) {
        needsLocalUpdate = true // deleted elsewhere — drop locally
      } else {
        mergedApiAccounts.push(localAccount)
        needsServerSyncApi = true
      }
    }
  }

  // === LN Address wallets ===
  const mergedLnAddressWallets: MergeableAccount[] = []
  for (const serverWallet of server.blinkLnAddressWallets) {
    const localWallet = localLnAddressWallets.find((l) => l.id === serverWallet.id)
    if (localWallet) {
      const { item, changed } = markServerBacked(localWallet)
      mergedLnAddressWallets.push(item)
      if (changed) needsLocalUpdate = true
    } else {
      mergedLnAddressWallets.push({
        id: serverWallet.id,
        type: "ln-address",
        label: serverWallet.label,
        username: serverWallet.username,
        lightningAddress: serverWallet.lightningAddress,
        walletId: serverWallet.walletId,
        isActive: false,
        createdAt: new Date(serverWallet.createdAt).getTime(),
        lastUsed: serverWallet.lastUsed
          ? new Date(serverWallet.lastUsed).getTime()
          : undefined,
        source: "server",
      })
      needsLocalUpdate = true
    }
  }
  for (const localWallet of localLnAddressWallets) {
    if (!server.blinkLnAddressWallets.find((s) => s.id === localWallet.id)) {
      if (wasFromServer(localWallet)) {
        needsLocalUpdate = true
      } else {
        mergedLnAddressWallets.push(localWallet)
        needsServerSyncLnAddr = true
      }
    }
  }

  // === npub.cash wallets ===
  const mergedNpubCashWallets: MergeableAccount[] = []
  for (const serverWallet of server.npubCashWallets) {
    const localWallet = localNpubCashWallets.find((l) => l.id === serverWallet.id)
    if (localWallet) {
      const { item, changed } = markServerBacked(localWallet)
      mergedNpubCashWallets.push(item)
      if (changed) needsLocalUpdate = true
    } else {
      mergedNpubCashWallets.push({
        id: serverWallet.id,
        type: "npub-cash",
        label: serverWallet.label,
        lightningAddress: serverWallet.lightningAddress || serverWallet.address,
        localpart: serverWallet.localpart,
        isNpub: serverWallet.isNpub,
        pubkey: serverWallet.pubkey,
        isActive: false,
        createdAt: serverWallet.createdAt
          ? new Date(serverWallet.createdAt).getTime()
          : Date.now(),
        lastUsed: serverWallet.lastUsed
          ? new Date(serverWallet.lastUsed).getTime()
          : undefined,
        source: "server",
      })
      needsLocalUpdate = true
    }
  }
  for (const localWallet of localNpubCashWallets) {
    if (!server.npubCashWallets.find((s) => s.id === localWallet.id)) {
      if (wasFromServer(localWallet)) {
        needsLocalUpdate = true
      } else {
        mergedNpubCashWallets.push(localWallet)
        needsServerSyncNpubCash = true
      }
    }
  }

  const mergedAccounts: MergeableAccount[] = [
    ...mergedApiAccounts,
    ...mergedLnAddressWallets,
    ...mergedNpubCashWallets,
  ]
  // Ensure exactly-one active survives a delete-elsewhere of the active item.
  if (mergedAccounts.length > 0 && !mergedAccounts.some((a) => a.isActive)) {
    mergedAccounts[0].isActive = true
    needsLocalUpdate = true
  }

  // === NWC connections ===
  // NWC connections were never synced historically and carry no source marker,
  // so we cannot tell "new" from "deleted elsewhere" here. Union them (keep
  // local-only ones and push up) to avoid dropping a working connection;
  // explicit deletions still propagate via the removeNWCConnection path.
  const mergedNwcConnections: StoredNWCConnection[] = []
  let needsServerSyncNwc = false
  for (const serverConn of server.nwcConnections) {
    const localConn = localNwcConnections.find((l) => l.id === serverConn.id)
    if (localConn) {
      mergedNwcConnections.push(localConn)
    } else {
      const plaintextUri = serverConn.uri as unknown as string
      if (plaintextUri) {
        try {
          const encryptedUri = await encryptWithDeviceKey(plaintextUri)
          mergedNwcConnections.push({
            id: serverConn.id,
            label: serverConn.label,
            uri: encryptedUri,
            capabilities: serverConn.capabilities || [],
            isActive: false,
            createdAt: serverConn.createdAt || Date.now(),
          })
          needsLocalUpdate = true
        } catch {
          // Skip connections we cannot encrypt for this device.
        }
      }
    }
  }
  for (const localConn of localNwcConnections) {
    if (!server.nwcConnections.find((s) => s.id === localConn.id)) {
      mergedNwcConnections.push(localConn)
      needsServerSyncNwc = true
    }
  }
  if (mergedNwcConnections.length > 0 && !mergedNwcConnections.some((c) => c.isActive)) {
    mergedNwcConnections[0].isActive = true
    needsLocalUpdate = true
  }

  return {
    mergedAccounts,
    mergedNwcConnections,
    needsLocalUpdate,
    needsServerSyncApi,
    needsServerSyncLnAddr,
    needsServerSyncNpubCash,
    needsServerSyncNwc,
  }
}

/** Per-field push callbacks used to persist local-only items to the server. */
export interface SyncPushers {
  pushApi: (accounts: MergeableAccount[]) => Promise<void>
  pushLnAddr: (accounts: MergeableAccount[]) => Promise<void>
  pushNpubCash: (accounts: MergeableAccount[]) => Promise<void>
  pushNwc: (connections: StoredNWCConnection[]) => Promise<void>
}

/**
 * Push every wallet category that the merge flagged as having local-only items,
 * one after another.
 *
 * This MUST run the pushes sequentially (awaiting each) rather than firing
 * debounced helpers back-to-back: the debounced sync helpers share a single
 * timer and cancel one another, so a fire-and-forget approach would persist
 * only the last category and leave the rest unsynced. Running each push to
 * completion guarantees a mixed local-only profile (e.g. an API-key wallet AND
 * an LN-address wallet) is fully written so other devices can converge.
 */
export async function pushLocalOnlyToServer(
  plan: MergeResult,
  pushers: SyncPushers,
): Promise<void> {
  if (plan.needsServerSyncApi) {
    await pushers.pushApi(plan.mergedAccounts)
  }
  if (plan.needsServerSyncLnAddr) {
    await pushers.pushLnAddr(plan.mergedAccounts)
  }
  if (plan.needsServerSyncNpubCash) {
    await pushers.pushNpubCash(plan.mergedAccounts)
  }
  if (plan.needsServerSyncNwc) {
    await pushers.pushNwc(plan.mergedNwcConnections)
  }
}
