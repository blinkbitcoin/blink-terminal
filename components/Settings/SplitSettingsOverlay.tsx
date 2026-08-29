/**
 * SplitSettingsOverlay - Payment split profile selection and management
 * Extracted from Dashboard.js
 */
import { getLnAddressDomain } from "../../lib/config/api"
import { isSplitPaymentsEnabled } from "../../lib/config/features"
import type { AuthMode } from "../../lib/hooks/useCombinedAuth"
import type {
  SplitProfile,
  SplitRecipient,
  RecipientValidationState,
} from "../../lib/hooks/useSplitProfiles"

interface SplitSettingsOverlayProps {
  authMode: AuthMode
  activeSplitProfile: SplitProfile | null
  splitProfiles: SplitProfile[]
  splitProfilesLoading: boolean
  isBlinkClassic: boolean
  isBlinkClassicDark: boolean
  isBlinkClassicLight: boolean
  setShowTipSettings: (show: boolean) => void
  setShowCreateSplitProfile: (show: boolean) => void
  setActiveSplitProfileById: (id: string | null) => void
  setEditingSplitProfile: (profile: SplitProfile | null) => void
  setNewSplitProfileLabel: (label: string) => void
  setNewSplitProfileRecipients: (recipients: SplitRecipient[]) => void
  setNewRecipientInput: (input: string) => void
  setRecipientValidation: (validation: RecipientValidationState) => void
  setSplitProfileError: (error: string | null) => void
  setUseCustomWeights: (use: boolean) => void
  deleteSplitProfile: (id: string) => Promise<boolean | void>
  getSubmenuBgClasses: () => string
  getSubmenuHeaderClasses: () => string
  getSubmenuOptionClasses: () => string
  getSubmenuOptionActiveClasses: () => string
  getPrimaryTextClasses: () => string
  getSecondaryTextClasses: () => string
  getCheckmarkClasses: () => string
  getPreviewBoxClasses: () => string
}

export default function SplitSettingsOverlay({
  authMode,
  activeSplitProfile,
  splitProfiles,
  splitProfilesLoading,
  isBlinkClassic,
  isBlinkClassicDark,
  isBlinkClassicLight: _isBlinkClassicLight,
  setShowTipSettings,
  setShowCreateSplitProfile,
  setActiveSplitProfileById,
  setEditingSplitProfile,
  setNewSplitProfileLabel,
  setNewSplitProfileRecipients,
  setNewRecipientInput,
  setRecipientValidation,
  setSplitProfileError,
  setUseCustomWeights,
  deleteSplitProfile,
  getSubmenuBgClasses,
  getSubmenuHeaderClasses,
  getSubmenuOptionClasses,
  getSubmenuOptionActiveClasses,
  getPrimaryTextClasses,
  getSecondaryTextClasses,
  getCheckmarkClasses,
  getPreviewBoxClasses,
}: SplitSettingsOverlayProps) {
  const lnAddressDomain = getLnAddressDomain()

  return (
    <div className={`fixed inset-0 ${getSubmenuBgClasses()} z-50 overflow-y-auto`}>
      <div
        className="min-h-screen"
        style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
      >
        {/* Header */}
        <div className={`${getSubmenuHeaderClasses()} sticky top-0 z-10`}>
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex justify-between items-center h-16">
              <button
                onClick={() => setShowTipSettings(false)}
                className={`flex items-center ${getPrimaryTextClasses()} hover:text-blink-classic-amber`}
              >
                <span className="text-2xl mr-2">‹</span>
                <span className="text-lg">Back</span>
              </button>
              <h1 className={`text-xl font-bold ${getPrimaryTextClasses()}`}>
                Payment Splits
              </h1>
              <div className="w-16"></div>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="max-w-md mx-auto px-4 py-6">
          <div className="space-y-4">
            {/* Temporarily unavailable notice */}
            {!isSplitPaymentsEnabled() && (
              <div
                className={`p-4 rounded-xl border ${
                  isBlinkClassicDark
                    ? "bg-amber-950/40 border-amber-800 text-amber-200"
                    : "bg-amber-50 border-amber-300 text-amber-800"
                }`}
              >
                <h3 className="font-semibold text-sm">Temporarily unavailable</h3>
                <p className="mt-1 text-xs">
                  Split Payments are paused while we move payments off the intermediary
                  account. Your profiles below are saved and will work again once the
                  feature returns.
                </p>
              </div>
            )}

            {/* Create New Profile Button */}
            {authMode === "nostr" && (
              <button
                onClick={() => {
                  setEditingSplitProfile(null)
                  setNewSplitProfileLabel("")
                  setNewSplitProfileRecipients([])
                  setNewRecipientInput("")
                  setRecipientValidation({
                    status: null,
                    message: "",
                    isValidating: false,
                  })
                  setSplitProfileError(null)
                  setUseCustomWeights(false)
                  setShowCreateSplitProfile(true)
                }}
                className={`w-full py-3 text-sm font-medium rounded-xl transition-colors flex items-center justify-center gap-2 ${
                  isBlinkClassic
                    ? "bg-blink-classic-amber text-black hover:bg-blink-classic-amber/90"
                    : "bg-blink-accent text-black hover:bg-blink-accent/90"
                }`}
              >
                <span className="text-lg">+</span>
                <span>New Split Profile</span>
              </button>
            )}

            {/* None Option */}
            <button
              onClick={() => {
                setActiveSplitProfileById(null)
                setShowTipSettings(false)
              }}
              className={`w-full p-4 transition-all ${
                !activeSplitProfile
                  ? getSubmenuOptionActiveClasses()
                  : getSubmenuOptionClasses()
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="text-left">
                  <h3 className={`text-lg font-semibold mb-1 ${getPrimaryTextClasses()}`}>
                    None
                  </h3>
                  <p className={`text-sm ${getSecondaryTextClasses()}`}>
                    Payment splits disabled
                  </p>
                </div>
                {!activeSplitProfile && (
                  <div className={`text-2xl ${getCheckmarkClasses()}`}>✓</div>
                )}
              </div>
            </button>

            {/* Loading State */}
            {splitProfilesLoading && (
              <div className="flex justify-center py-8">
                <div
                  className={`animate-spin rounded-full h-8 w-8 border-2 border-t-transparent ${isBlinkClassic ? "border-blink-classic-amber" : "border-blink-accent"}`}
                ></div>
              </div>
            )}

            {/* Split Profiles List */}
            {!splitProfilesLoading &&
              splitProfiles.map((profile) => {
                // Check if profile uses custom weights (not evenly distributed)
                const evenShare = 100 / (profile.recipients?.length || 1)
                const hasCustomWeights = profile.recipients?.some(
                  (r) => Math.abs((r.share || evenShare) - evenShare) > 0.01,
                )

                return (
                  <div
                    key={profile.id}
                    className={`w-full p-4 transition-all ${
                      activeSplitProfile?.id === profile.id
                        ? getSubmenuOptionActiveClasses()
                        : getSubmenuOptionClasses()
                    }`}
                  >
                    <button
                      onClick={() => {
                        setActiveSplitProfileById(profile.id)
                        setShowTipSettings(false)
                      }}
                      className="w-full"
                    >
                      <div className="flex items-center justify-between">
                        <div className="text-left">
                          <h3
                            className={`text-lg font-semibold mb-1 ${getPrimaryTextClasses()}`}
                          >
                            {profile.label}
                          </h3>
                          <p className={`text-sm ${getSecondaryTextClasses()}`}>
                            {hasCustomWeights
                              ? profile.recipients
                                  .map((r) => {
                                    const name =
                                      r.type === "npub_cash"
                                        ? r.username
                                        : `${r.username}@${lnAddressDomain}`
                                    return `${name} (${Math.round(r.share || evenShare)}%)`
                                  })
                                  .join(", ")
                              : profile.recipients
                                  .map((r) =>
                                    r.type === "npub_cash"
                                      ? r.username
                                      : `${r.username}@${lnAddressDomain}`,
                                  )
                                  .join(", ")}
                          </p>
                        </div>
                        {activeSplitProfile?.id === profile.id && (
                          <div className={`text-2xl ${getCheckmarkClasses()}`}>✓</div>
                        )}
                      </div>
                    </button>
                    {/* Edit/Delete Actions */}
                    <div
                      className={`flex gap-2 mt-3 pt-3 border-t ${isBlinkClassic ? (isBlinkClassicDark ? "border-blink-classic-border" : "border-blink-classic-border-light") : "border-gray-200 dark:border-gray-700"}`}
                    >
                      <button
                        onClick={() => {
                          setEditingSplitProfile(profile)
                          setNewSplitProfileLabel(profile.label)
                          // Initialize recipients array from profile with weights
                          const recipients: SplitRecipient[] =
                            profile.recipients?.map((r) => ({
                              username: r.username,
                              validated: true,
                              type: r.type || "blink",
                              weight: r.share || 100 / (profile.recipients?.length || 1),
                            })) || []
                          setNewSplitProfileRecipients(recipients)
                          // Check if profile uses custom weights (not evenly distributed)
                          const evenShareLocal = 100 / (recipients.length || 1)
                          const hasCustomWeightsLocal = recipients.some(
                            (r) => Math.abs((r.weight || 0) - evenShareLocal) > 0.01,
                          )
                          setUseCustomWeights(hasCustomWeightsLocal)
                          setNewRecipientInput("")
                          setRecipientValidation({
                            status: null,
                            message: "",
                            isValidating: false,
                          })
                          setSplitProfileError(null)
                          setShowCreateSplitProfile(true)
                        }}
                        className={`flex-1 py-2 text-sm rounded-lg transition-colors ${
                          isBlinkClassic
                            ? `${getSecondaryTextClasses()} hover:text-blink-classic-amber border ${isBlinkClassicDark ? "border-blink-classic-border" : "border-blink-classic-border-light"}`
                            : "text-gray-600 dark:text-gray-400 hover:text-blink-accent border border-gray-300 dark:border-gray-600"
                        }`}
                      >
                        Edit
                      </button>
                      <button
                        onClick={async () => {
                          if (confirm("Delete this split profile?")) {
                            await deleteSplitProfile(profile.id)
                          }
                        }}
                        className={`flex-1 py-2 text-sm rounded-lg text-red-500 hover:text-red-700 border transition-colors ${
                          isBlinkClassic
                            ? isBlinkClassicDark
                              ? "border-blink-classic-border"
                              : "border-blink-classic-border-light"
                            : "border-gray-300 dark:border-gray-600"
                        }`}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )
              })}

            {/* No Profiles Yet Message */}
            {!splitProfilesLoading &&
              splitProfiles.length === 0 &&
              authMode === "nostr" && (
                <div className={`p-6 text-center ${getPreviewBoxClasses()}`}>
                  <p className={`mb-2 ${getSecondaryTextClasses()}`}>
                    No split profiles yet
                  </p>
                  <p className={`text-sm ${getSecondaryTextClasses()}`}>
                    Create a split profile to automatically share a portion of payments
                    with another Blink user.
                  </p>
                </div>
              )}

            {/* Not Signed In Message */}
            {authMode !== "nostr" && (
              <div className={`p-6 text-center ${getPreviewBoxClasses()}`}>
                <p className={`mb-2 ${getSecondaryTextClasses()}`}>
                  Sign in with Nostr to use split profiles
                </p>
                <p className={`text-sm ${getSecondaryTextClasses()}`}>
                  Split profiles are synced across devices and require Nostr
                  authentication.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
