/**
 * TippingSection - Configure tipping settings
 */

import { useState, useEffect } from "react"

import { isSplitPaymentsEnabled } from "../../lib/config/features"
import { useCombinedAuth } from "../../lib/hooks/useCombinedAuth"
import { useTheme } from "../../lib/hooks/useTheme"

const PRESET_PERCENTAGES = [5, 10, 15, 20, 25]

interface ToggleProps {
  value: boolean
  onChange: () => void
}

export default function TippingSection() {
  const { tippingSettings, updateTippingSettings } = useCombinedAuth()
  const { darkMode } = useTheme()

  const [enabled, setEnabled] = useState<boolean>(tippingSettings?.enabled ?? true)
  const [customPercentages, setCustomPercentages] = useState<number[]>(
    tippingSettings?.customPercentages ?? [10, 15, 20],
  )
  const [allowCustomAmount, setAllowCustomAmount] = useState<boolean>(
    tippingSettings?.allowCustomAmount ?? true,
  )
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (tippingSettings) {
      setEnabled(tippingSettings.enabled ?? true)
      setCustomPercentages(tippingSettings.customPercentages ?? [10, 15, 20])
      setAllowCustomAmount(tippingSettings.allowCustomAmount ?? true)
    }
  }, [tippingSettings])

  const handleSave = () => {
    setSaving(true)
    try {
      const result = updateTippingSettings({
        enabled,
        customPercentages,
        allowCustomAmount,
      })

      if (result?.success) {
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      }
    } catch (err: unknown) {
      console.error("Failed to save:", err)
    } finally {
      setSaving(false)
    }
  }

  const handlePercentageToggle = (percentage: number) => {
    if (customPercentages.includes(percentage)) {
      setCustomPercentages(customPercentages.filter((p) => p !== percentage))
    } else {
      setCustomPercentages([...customPercentages, percentage].sort((a, b) => a - b))
    }
  }

  // Toggle switch component matching Dashboard style
  const Toggle = ({ value, onChange }: ToggleProps) => (
    <button
      onClick={onChange}
      className="inline-flex gap-0.5 cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600 focus:ring-offset-2 rounded"
    >
      <span
        className={`w-5 h-5 transition-colors ${
          value ? "bg-blue-600 dark:bg-blue-500" : "bg-gray-300 dark:bg-gray-600"
        }`}
      />
      <span
        className={`w-5 h-5 transition-colors ${
          value ? "bg-gray-300 dark:bg-gray-600" : "bg-blink-accent"
        }`}
      />
    </button>
  )

  const splitsEnabled = isSplitPaymentsEnabled()

  return (
    <div className="space-y-4">
      {!splitsEnabled && (
        <div
          className={`rounded-lg p-4 border ${
            darkMode
              ? "bg-amber-950/40 border-amber-800 text-amber-200"
              : "bg-amber-50 border-amber-300 text-amber-800"
          }`}
        >
          <h4 className="font-medium text-sm">Tipping temporarily unavailable</h4>
          <p className="mt-1 text-xs">
            Tipping and Split Payments are paused while we move payments off the
            intermediary account. Your saved settings are preserved and will apply again
            once the feature returns.
          </p>
        </div>
      )}

      {/* Enable Tipping */}
      <div className={`rounded-lg p-4 ${darkMode ? "bg-gray-900" : "bg-gray-50"}`}>
        <div className="flex items-center justify-between">
          <div>
            <h4
              className={`font-medium text-sm ${darkMode ? "text-white" : "text-gray-900"}`}
            >
              Enable Tipping
            </h4>
          </div>
          <div className="flex items-center gap-2">
            <Toggle value={enabled} onChange={() => setEnabled(!enabled)} />
            <span className={`text-sm ${darkMode ? "text-white" : "text-gray-700"}`}>
              {enabled ? "ON" : "OFF"}
            </span>
          </div>
        </div>
      </div>

      {enabled && (
        <>
          {/* Quick Tip Options */}
          <div className={`rounded-lg p-4 ${darkMode ? "bg-gray-900" : "bg-gray-50"}`}>
            <h4
              className={`font-medium text-sm mb-3 ${darkMode ? "text-white" : "text-gray-900"}`}
            >
              Quick Options
            </h4>
            <div className="flex flex-wrap gap-2">
              {PRESET_PERCENTAGES.map((percentage) => (
                <button
                  key={percentage}
                  onClick={() => handlePercentageToggle(percentage)}
                  className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                    customPercentages.includes(percentage)
                      ? "bg-blink-accent text-black"
                      : darkMode
                        ? "bg-gray-800 text-gray-300 hover:bg-gray-700"
                        : "bg-gray-200 text-gray-700 hover:bg-gray-300"
                  }`}
                >
                  {percentage}%
                </button>
              ))}
            </div>
          </div>

          {/* Custom Amount */}
          <div className={`rounded-lg p-4 ${darkMode ? "bg-gray-900" : "bg-gray-50"}`}>
            <div className="flex items-center justify-between">
              <h4
                className={`font-medium text-sm ${darkMode ? "text-white" : "text-gray-900"}`}
              >
                Allow Custom Amount
              </h4>
              <div className="flex items-center gap-2">
                <Toggle
                  value={allowCustomAmount}
                  onChange={() => setAllowCustomAmount(!allowCustomAmount)}
                />
                <span className={`text-sm ${darkMode ? "text-white" : "text-gray-700"}`}>
                  {allowCustomAmount ? "ON" : "OFF"}
                </span>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Save Button */}
      <button
        onClick={handleSave}
        disabled={saving}
        className={`w-full py-2 rounded-md text-sm font-medium transition-colors ${
          saved
            ? "bg-green-500 text-white"
            : "bg-blink-accent text-black hover:bg-blink-accent/90"
        } disabled:opacity-50`}
      >
        {saving ? "Saving..." : saved ? "Saved" : "Save Changes"}
      </button>
    </div>
  )
}
