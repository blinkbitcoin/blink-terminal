/**
 * PublicPOSThemeCycleOverlay - Selectable theme-cycle overlay (public POS).
 *
 * Public-side equivalent of components/Settings/ThemeCycleOverlay. Selecting a
 * theme enables it in the logo-tap cycle AND applies it immediately; deselecting
 * removes it without switching. The last enabled theme can't be turned off.
 */
import { type Theme, THEME_ORDER, THEME_LABELS } from "../../lib/hooks/useTheme"

const THEME_DESCRIPTIONS: Record<Theme, string> = {
  "blink-classic-dark": "Blink dark (default)",
  "blink-classic-light": "Blink light",
  "dark": "Retro terminal, dark",
  "light": "Retro terminal, light",
}

interface PublicPOSThemeCycleOverlayProps {
  theme: Theme
  enabledThemes: Theme[]
  setEnabledThemes: (themes: Theme[]) => void
  setTheme: (theme: Theme) => void
  onClose: () => void
  getSubmenuBgClasses: () => string
  getSubmenuHeaderClasses: () => string
  getSelectionTileClasses: () => string
  getSelectionTileActiveClasses: () => string
}

export default function PublicPOSThemeCycleOverlay({
  theme,
  enabledThemes,
  setEnabledThemes,
  setTheme,
  onClose,
  getSubmenuBgClasses,
  getSubmenuHeaderClasses,
  getSelectionTileClasses,
  getSelectionTileActiveClasses,
}: PublicPOSThemeCycleOverlayProps) {
  const toggle = (id: Theme): void => {
    const isEnabled = enabledThemes.includes(id)
    if (isEnabled) {
      if (enabledThemes.length <= 1) {
        return
      }
      setEnabledThemes(enabledThemes.filter((t) => t !== id))
      return
    }
    setEnabledThemes([...enabledThemes, id])
    setTheme(id)
  }

  return (
    <div className={`fixed inset-0 ${getSubmenuBgClasses()} z-50 overflow-y-auto`}>
      <div className="min-h-screen">
        {/* Header */}
        <div className={`${getSubmenuHeaderClasses()} sticky top-0 z-10`}>
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex justify-between items-center h-16">
              <button
                onClick={onClose}
                className="flex items-center text-gray-700 dark:text-white hover:text-blink-accent dark:hover:text-blink-accent"
              >
                <span className="text-2xl mr-2">‹</span>
                <span className="text-lg">Back</span>
              </button>
              <h1
                className="text-xl font-bold text-gray-900 dark:text-white"
                style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
              >
                Theme
              </h1>
              <div className="w-16"></div>
            </div>
          </div>
        </div>

        {/* Themes List */}
        <div className="max-w-md mx-auto px-4 py-6">
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            Tap the POS logo to cycle through the selected themes.
          </p>
          <div className="space-y-3">
            {THEME_ORDER.map((id) => {
              const selected = enabledThemes.includes(id)
              return (
                <button
                  key={id}
                  onClick={() => toggle(id)}
                  data-testid={`theme-option-${id}`}
                  className={`w-full p-4 rounded-lg border-2 transition-all ${
                    selected ? getSelectionTileActiveClasses() : getSelectionTileClasses()
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="text-left">
                      <h3
                        className="text-lg font-semibold text-gray-900 dark:text-white mb-1"
                        style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
                      >
                        {THEME_LABELS[id]}
                        {theme === id && (
                          <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">
                            (active)
                          </span>
                        )}
                      </h3>
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        {THEME_DESCRIPTIONS[id]}
                      </p>
                    </div>
                    {selected && <div className="text-blink-accent text-2xl">✓</div>}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
