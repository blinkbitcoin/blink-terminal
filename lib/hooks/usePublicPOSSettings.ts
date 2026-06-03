import { useState, useEffect, type Dispatch, type SetStateAction } from "react"

import type { SoundThemeName } from "../audio-utils"
import {
  DEFAULT_AMOUNT_DISPLAY,
  type NumberFormatPreference,
  type BitcoinFormatPreference,
  type NumpadLayoutPreference,
  type AmountDisplayPreference,
} from "../number-format"
import type { OrangePillMode } from "../orangepill"

interface UsePublicPOSSettingsReturn {
  displayCurrency: string
  setDisplayCurrency: Dispatch<SetStateAction<string>>
  numberFormat: NumberFormatPreference
  setNumberFormat: Dispatch<SetStateAction<NumberFormatPreference>>
  bitcoinFormat: BitcoinFormatPreference
  setBitcoinFormat: Dispatch<SetStateAction<BitcoinFormatPreference>>
  numpadLayout: NumpadLayoutPreference
  setNumpadLayout: Dispatch<SetStateAction<NumpadLayoutPreference>>
  amountDisplay: AmountDisplayPreference
  setAmountDisplay: Dispatch<SetStateAction<AmountDisplayPreference>>
  soundEnabled: boolean
  setSoundEnabled: Dispatch<SetStateAction<boolean>>
  soundTheme: SoundThemeName
  setSoundTheme: Dispatch<SetStateAction<SoundThemeName>>
  orangePillMode: OrangePillMode
  setOrangePillMode: Dispatch<SetStateAction<OrangePillMode>>
  orangePillStaticUrl: string
  setOrangePillStaticUrl: Dispatch<SetStateAction<string>>
}

/**
 * usePublicPOSSettings - Manages display/sound settings for PublicPOSDashboard
 *
 * Handles:
 * - Display currency selection
 * - Number format, Bitcoin format, numpad layout
 * - Sound enabled/theme
 * - All localStorage persistence (publicpos-* keys)
 */
export function usePublicPOSSettings(): UsePublicPOSSettingsReturn {
  const [displayCurrency, setDisplayCurrency] = useState("USD")

  const [numberFormat, setNumberFormat] = useState<NumberFormatPreference>(() => {
    if (typeof window !== "undefined") {
      return (
        (localStorage.getItem("publicpos-numberFormat") as NumberFormatPreference) ||
        "auto"
      )
    }
    return "auto"
  })

  const [bitcoinFormat, setBitcoinFormat] = useState<BitcoinFormatPreference>(() => {
    if (typeof window !== "undefined") {
      return (
        (localStorage.getItem("publicpos-bitcoinFormat") as BitcoinFormatPreference) ||
        "sats"
      )
    }
    return "bip177"
  })

  const [numpadLayout, setNumpadLayout] = useState<NumpadLayoutPreference>(() => {
    if (typeof window !== "undefined") {
      return (
        (localStorage.getItem("publicpos-numpadLayout") as NumpadLayoutPreference) ||
        "calculator"
      )
    }
    return "calculator"
  })

  const [amountDisplay, setAmountDisplay] = useState<AmountDisplayPreference>(() => {
    if (typeof window !== "undefined") {
      return (
        (localStorage.getItem("publicpos-amountDisplay") as AmountDisplayPreference) ||
        DEFAULT_AMOUNT_DISPLAY
      )
    }
    return DEFAULT_AMOUNT_DISPLAY
  })

  const [soundEnabled, setSoundEnabled] = useState(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("publicpos-soundEnabled")
      return saved !== null ? (JSON.parse(saved) as boolean) : true
    }
    return true
  })

  const [soundTheme, setSoundTheme] = useState<SoundThemeName>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("publicpos-soundTheme")
      return (saved as SoundThemeName) || "success"
    }
    return "success"
  })

  const [orangePillMode, setOrangePillMode] = useState<OrangePillMode>(() => {
    if (typeof window !== "undefined") {
      return (localStorage.getItem("publicpos-orangePillMode") as OrangePillMode) || "off"
    }
    return "off"
  })

  const [orangePillStaticUrl, setOrangePillStaticUrl] = useState<string>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("publicpos-orangePillStaticUrl") || ""
    }
    return ""
  })

  // Persist all settings to localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("publicpos-soundEnabled", JSON.stringify(soundEnabled))
    }
  }, [soundEnabled])

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("publicpos-soundTheme", soundTheme)
    }
  }, [soundTheme])

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("publicpos-numberFormat", numberFormat)
    }
  }, [numberFormat])

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("publicpos-bitcoinFormat", bitcoinFormat)
    }
  }, [bitcoinFormat])

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("publicpos-numpadLayout", numpadLayout)
    }
  }, [numpadLayout])

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("publicpos-amountDisplay", amountDisplay)
    }
  }, [amountDisplay])

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("publicpos-orangePillMode", orangePillMode)
    }
  }, [orangePillMode])

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("publicpos-orangePillStaticUrl", orangePillStaticUrl)
    }
  }, [orangePillStaticUrl])

  return {
    displayCurrency,
    setDisplayCurrency,
    numberFormat,
    setNumberFormat,
    bitcoinFormat,
    setBitcoinFormat,
    numpadLayout,
    setNumpadLayout,
    amountDisplay,
    setAmountDisplay,
    soundEnabled,
    setSoundEnabled,
    soundTheme,
    setSoundTheme,
    orangePillMode,
    setOrangePillMode,
    orangePillStaticUrl,
    setOrangePillStaticUrl,
  }
}
