import { useState, useEffect, type Dispatch, type SetStateAction } from "react"

/**
 * usePublicPOSMenuState - Manages menu/overlay visibility for PublicPOSDashboard
 *
 * Handles:
 * - Side menu open/close
 * - Currency settings overlay + search filter with debounce
 * - Regional settings overlay
 * - Sound settings overlay
 * - Paycode overlay (visibility only; the paycode UI is the shared
 *   PrintPaycodeView, which owns its own PDF-generation state and is
 *   variable-amount only)
 */

interface UsePublicPOSMenuStateReturn {
  sideMenuOpen: boolean
  setSideMenuOpen: Dispatch<SetStateAction<boolean>>
  showCurrencySettings: boolean
  setShowCurrencySettings: Dispatch<SetStateAction<boolean>>
  currencyFilter: string
  setCurrencyFilter: Dispatch<SetStateAction<string>>
  currencyFilterDebounced: string
  showRegionalSettings: boolean
  setShowRegionalSettings: Dispatch<SetStateAction<boolean>>
  showSoundSettings: boolean
  setShowSoundSettings: Dispatch<SetStateAction<boolean>>
  showPaycode: boolean
  setShowPaycode: Dispatch<SetStateAction<boolean>>
}

export function usePublicPOSMenuState(): UsePublicPOSMenuStateReturn {
  const [sideMenuOpen, setSideMenuOpen] = useState(false)
  const [showCurrencySettings, setShowCurrencySettings] = useState(false)
  const [currencyFilter, setCurrencyFilter] = useState("")
  const [currencyFilterDebounced, setCurrencyFilterDebounced] = useState("")
  const [showRegionalSettings, setShowRegionalSettings] = useState(false)
  const [showSoundSettings, setShowSoundSettings] = useState(false)
  const [showPaycode, setShowPaycode] = useState(false)

  // Debounce currency filter (150ms delay)
  useEffect(() => {
    const timer = setTimeout(() => {
      setCurrencyFilterDebounced(currencyFilter)
    }, 150)
    return () => clearTimeout(timer)
  }, [currencyFilter])

  // Reset currency filter when closing the currency settings overlay
  useEffect(() => {
    if (!showCurrencySettings) {
      setCurrencyFilter("")
      setCurrencyFilterDebounced("")
    }
  }, [showCurrencySettings])

  return {
    sideMenuOpen,
    setSideMenuOpen,
    showCurrencySettings,
    setShowCurrencySettings,
    currencyFilter,
    setCurrencyFilter,
    currencyFilterDebounced,
    showRegionalSettings,
    setShowRegionalSettings,
    showSoundSettings,
    setShowSoundSettings,
    showPaycode,
    setShowPaycode,
  }
}
