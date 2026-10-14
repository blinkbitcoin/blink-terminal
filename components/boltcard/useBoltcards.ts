/**
 * useBoltcards - React hook for Boltcard management
 *
 * Provides state management and API calls for:
 * - Listing user's cards
 * - Registering new cards
 * - Updating card settings
 * - Card actions (activate, disable, enable, etc.)
 */

import { useState, useEffect, useCallback } from "react"

// ============================================================================
// Types & Interfaces
// ============================================================================

/**
 * Card status constants
 * NOTE: These must match the values in lib/boltcard/store.ts (uppercase)
 */
export const CardStatus = {
  PENDING: "PENDING",
  ACTIVE: "ACTIVE",
  DISABLED: "DISABLED",
  WIPED: "WIPED",
} as const

export type CardStatusValue = (typeof CardStatus)[keyof typeof CardStatus]

/**
 * Card currency constants
 */
export const CardCurrency = {
  BTC: "BTC",
  USD: "USD",
} as const

export type CardCurrencyValue = (typeof CardCurrency)[keyof typeof CardCurrency]

/** Represents a single Boltcard record from the API */
export interface BoltcardRecord {
  id: string
  cardUid: string
  cardIdHash?: string
  name: string | null
  ownerPubkey: string
  walletId: string
  walletCurrency: string
  version: number
  lastCounter: number
  balance: number
  maxTxAmount: number | null
  dailyLimit: number | null
  dailySpent: number
  dailyResetAt: number | null
  status: string
  createdAt: string | number
  activatedAt: string | number | null
  lastUsedAt: string | number | null
  disabledAt: string | number | null
  environment: string
}

/** A transaction associated with a card */
export interface BoltcardTransaction {
  id?: string
  type: string
  amount: number
  description?: string
  createdAt: string | number
}

/** Top-up QR code data from API */
export interface TopUpQRData {
  lnurl: string
  [key: string]: unknown
}

/** Generic API response shape */
interface ApiResponse {
  error?: string
  message?: string
  [key: string]: unknown
}

/** Result of fetching card details */
export interface FetchDetailsResult {
  success: boolean
  card?: BoltcardRecord
  transactions?: BoltcardTransaction[]
  topUpQR?: TopUpQRData
  error?: string
}

/** Parameters for registering a card */
export interface RegisterCardParams {
  cardUid?: string
  walletId: string
  apiKey: string
  name?: string
  walletCurrency?: string
  maxTxAmount?: number | null
  dailyLimit?: number | null
  initialBalance?: number
  environment?: string
}

/** Result of a card registration */
export interface RegisterResult {
  success: boolean
  error?: string
  flow?: string
  // Direct flow fields
  card?: BoltcardRecord
  keys?: Record<string, string>
  qrCodes?: Record<string, string>
  // Deeplink flow fields
  pendingRegistration?: {
    id: string
    name?: string | null
    walletCurrency?: string
    expiresAt?: string
    [key: string]: unknown
  }
  deeplink?: string
  qrPayload?: string
  keysRequestUrl?: string
}

/** Result of a card action (enable, disable, activate, etc.) */
export interface CardActionResult {
  success: boolean
  error?: string
  message?: string
  card?: BoltcardRecord
}

/** Card update payload */
export interface CardUpdatePayload {
  name?: string | null
  maxTxAmount?: number | null
  dailyLimit?: number | null
  [key: string]: unknown
}

/** Result of funding a card */
export interface FundResult {
  success: boolean
  error?: string
  card?: BoltcardRecord
  transaction?: BoltcardTransaction
  warning?: string
  walletBalance?: number
}

/** Return type of the useBoltcards hook */
export interface UseBoltcardsReturn {
  // State
  cards: BoltcardRecord[]
  loading: boolean
  error: string | null
  selectedCard: BoltcardRecord | null
  setSelectedCard: React.Dispatch<React.SetStateAction<BoltcardRecord | null>>

  // Methods
  fetchCards: () => Promise<void>
  fetchCardDetails: (
    cardId: string,
    includeTopUpQR?: boolean,
  ) => Promise<FetchDetailsResult>
  registerCard: (params: RegisterCardParams) => Promise<RegisterResult>
  updateCard: (cardId: string, updates: CardUpdatePayload) => Promise<CardActionResult>
  activateCard: (cardId: string) => Promise<CardActionResult>
  disableCard: (cardId: string) => Promise<CardActionResult>
  enableCard: (cardId: string) => Promise<CardActionResult>
  resetDailySpent: (cardId: string) => Promise<CardActionResult>
  adjustBalance: (
    cardId: string,
    amount: number,
    description?: string,
  ) => Promise<CardActionResult>
  fundCard: (
    cardId: string,
    amount: number,
    mode?: string,
    description?: string,
  ) => Promise<FundResult>
  wipeCard: (cardId: string) => Promise<CardActionResult>

  // Helpers
  hasCards: boolean
  activeCards: BoltcardRecord[]
  pendingCards: BoltcardRecord[]
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Custom hook for Boltcard management
 */
export function useBoltcards(ownerPubkey: string | null | undefined): UseBoltcardsReturn {
  const [cards, setCards] = useState<BoltcardRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedCard, setSelectedCard] = useState<BoltcardRecord | null>(null)

  /**
   * Fetch all cards for the owner
   */
  const fetchCards = useCallback(async () => {
    if (!ownerPubkey) {
      setCards([])
      return
    }

    setLoading(true)
    setError(null)

    try {
      // Owner comes from the session cookie; the pubkey is not sent.
      const response = await fetch("/api/boltcard/cards")
      const data: ApiResponse & { cards?: BoltcardRecord[] } = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to fetch cards")
      }

      setCards(data.cards || [])
    } catch (err: unknown) {
      console.error("Failed to fetch boltcards:", err)
      setError((err as Error).message)
      setCards([])
    } finally {
      setLoading(false)
    }
  }, [ownerPubkey])

  /**
   * Fetch a single card with details
   */
  const fetchCardDetails = useCallback(
    async (cardId: string, includeTopUpQR = true): Promise<FetchDetailsResult> => {
      try {
        const response = await fetch(
          `/api/boltcard/cards/${cardId}?includeTopUpQR=${includeTopUpQR}`,
        )
        const data: ApiResponse & {
          card?: BoltcardRecord
          transactions?: BoltcardTransaction[]
          topUpQR?: TopUpQRData
        } = await response.json()

        if (!response.ok) {
          throw new Error(data.error || "Failed to fetch card details")
        }

        return {
          success: true,
          card: data.card,
          transactions: data.transactions || [],
          topUpQR: data.topUpQR,
        }
      } catch (err: unknown) {
        console.error("Failed to fetch card details:", err)
        return { success: false, error: (err as Error).message }
      }
    },
    [],
  )

  /**
   * Register a new Boltcard
   */
  const registerCard = useCallback(
    async ({
      cardUid,
      walletId,
      apiKey,
      name,
      walletCurrency = "BTC",
      maxTxAmount,
      dailyLimit,
      initialBalance = 0,
      environment = "production",
    }: RegisterCardParams): Promise<RegisterResult> => {
      if (!ownerPubkey) {
        return { success: false, error: "Not authenticated" }
      }

      setLoading(true)
      setError(null)

      try {
        const response = await fetch("/api/boltcard/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cardUid,
            ownerPubkey,
            walletId,
            apiKey,
            name,
            walletCurrency,
            maxTxAmount,
            dailyLimit,
            initialBalance,
            environment,
          }),
        })

        const data: ApiResponse & {
          flow?: string
          card?: BoltcardRecord
          keys?: Record<string, string>
          qrCodes?: Record<string, string>
          pendingRegistration?: RegisterResult["pendingRegistration"]
          deeplink?: string
          qrPayload?: string
          keysRequestUrl?: string
        } = await response.json()

        if (!response.ok) {
          throw new Error(data.error || "Failed to register card")
        }

        // Refresh cards list (for direct flow where card is created)
        if (data.flow === "direct") {
          await fetchCards()
        }

        // Return the full API response - supports both deeplink and direct flows
        return {
          success: true,
          flow: data.flow,
          // Direct flow fields
          card: data.card,
          keys: data.keys,
          qrCodes: data.qrCodes,
          // Deeplink flow fields
          pendingRegistration: data.pendingRegistration,
          deeplink: data.deeplink,
          qrPayload: data.qrPayload,
          keysRequestUrl: data.keysRequestUrl,
        }
      } catch (err: unknown) {
        console.error("Failed to register boltcard:", err)
        setError((err as Error).message)
        return { success: false, error: (err as Error).message }
      } finally {
        setLoading(false)
      }
    },
    [ownerPubkey, fetchCards],
  )

  /**
   * Update card settings
   */
  const updateCard = useCallback(
    async (cardId: string, updates: CardUpdatePayload): Promise<CardActionResult> => {
      try {
        const response = await fetch(`/api/boltcard/cards/${cardId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updates),
        })

        const data: ApiResponse & { card?: BoltcardRecord } = await response.json()

        if (!response.ok) {
          throw new Error(data.error || "Failed to update card")
        }

        // Update local state
        setCards((prev) =>
          prev.map((card) => (card.id === cardId ? { ...card, ...data.card } : card)),
        )

        return { success: true, card: data.card }
      } catch (err: unknown) {
        console.error("Failed to update card:", err)
        return { success: false, error: (err as Error).message }
      }
    },
    [],
  )

  /**
   * Perform a card action (activate, disable, enable, adjust, resetDaily)
   */
  const cardAction = useCallback(
    async (
      cardId: string,
      action: string,
      params: Record<string, unknown> = {},
    ): Promise<CardActionResult> => {
      try {
        const response = await fetch(`/api/boltcard/cards/${cardId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ...params }),
        })

        const data: ApiResponse & { card?: BoltcardRecord } = await response.json()

        if (!response.ok) {
          throw new Error(data.error || `Failed to ${action} card`)
        }

        // Update local state
        setCards((prev) =>
          prev.map((card) => (card.id === cardId ? { ...card, ...data.card } : card)),
        )

        return { success: true, message: data.message, card: data.card }
      } catch (err: unknown) {
        console.error(`Failed to ${action} card:`, err)
        return { success: false, error: (err as Error).message }
      }
    },
    [],
  )

  /**
   * Activate a card
   */
  const activateCard = useCallback(
    async (cardId: string): Promise<CardActionResult> => {
      return cardAction(cardId, "activate")
    },
    [cardAction],
  )

  /**
   * Disable a card
   */
  const disableCard = useCallback(
    async (cardId: string): Promise<CardActionResult> => {
      return cardAction(cardId, "disable")
    },
    [cardAction],
  )

  /**
   * Enable a disabled card
   */
  const enableCard = useCallback(
    async (cardId: string): Promise<CardActionResult> => {
      return cardAction(cardId, "enable")
    },
    [cardAction],
  )

  /**
   * Reset daily spending limit
   */
  const resetDailySpent = useCallback(
    async (cardId: string): Promise<CardActionResult> => {
      return cardAction(cardId, "resetDaily")
    },
    [cardAction],
  )

  /**
   * Adjust card balance
   */
  const adjustBalance = useCallback(
    async (
      cardId: string,
      amount: number,
      description?: string,
    ): Promise<CardActionResult> => {
      return cardAction(cardId, "adjust", { amount, description })
    },
    [cardAction],
  )

  /**
   * Fund card from Sending Wallet
   * Supports both incrementing balance and setting total balance
   */
  const fundCard = useCallback(
    async (
      cardId: string,
      amount: number,
      mode: string = "increment",
      description?: string,
    ): Promise<FundResult> => {
      try {
        const body: Record<string, unknown> = {
          cardId,
          mode,
          description:
            description ||
            (mode === "set" ? "Balance adjusted" : "Funded from Sending Wallet"),
        }

        // Support both modes
        if (mode === "set") {
          body.newBalance = amount
        } else {
          body.amount = amount
        }

        const response = await fetch("/api/boltcard/fund", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })

        const data: ApiResponse & {
          card?: BoltcardRecord
          transaction?: BoltcardTransaction
          warning?: string
          walletBalance?: number
        } = await response.json()

        if (!response.ok) {
          throw new Error(data.error || "Failed to fund card")
        }

        // Update local state with new balance
        if (data.card) {
          setCards((prev) =>
            prev.map((card) =>
              card.id === cardId ? { ...card, balance: data.card!.balance } : card,
            ),
          )
        }

        return {
          success: true,
          card: data.card,
          transaction: data.transaction,
          warning: data.warning,
          walletBalance: data.walletBalance,
        }
      } catch (err: unknown) {
        console.error("Failed to fund card:", err)
        return { success: false, error: (err as Error).message }
      }
    },
    [],
  )

  /**
   * Wipe/delete a card
   */
  const wipeCard = useCallback(async (cardId: string): Promise<CardActionResult> => {
    try {
      const response = await fetch(`/api/boltcard/cards/${cardId}`, {
        method: "DELETE",
      })

      const data: ApiResponse = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to wipe card")
      }

      // Remove from local state
      setCards((prev) => prev.filter((card) => card.id !== cardId))

      return { success: true, message: data.message }
    } catch (err: unknown) {
      console.error("Failed to wipe card:", err)
      return { success: false, error: (err as Error).message }
    }
  }, [])

  // Fetch cards on mount and when ownerPubkey changes
  useEffect(() => {
    fetchCards()
  }, [fetchCards])

  return {
    // State
    cards,
    loading,
    error,
    selectedCard,
    setSelectedCard,

    // Methods
    fetchCards,
    fetchCardDetails,
    registerCard,
    updateCard,
    activateCard,
    disableCard,
    enableCard,
    resetDailySpent,
    adjustBalance,
    fundCard,
    wipeCard,

    // Helpers
    hasCards: cards.length > 0,
    activeCards: cards.filter((c) => c.status === CardStatus.ACTIVE),
    pendingCards: cards.filter((c) => c.status === CardStatus.PENDING),
  }
}

export default useBoltcards
