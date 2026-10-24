/**
 * PublicPOSPaycodeOverlay - Public POS side-menu → Paycodes menu.
 *
 * Thin wrapper around the shared PrintPaycodeView so the Paycodes menu and the
 * standalone `/[username]/print` page are identical. Variable-amount only (the
 * fixed-amount input was removed when the two were unified).
 */
import PrintPaycodeView from "./PrintPaycodeView"

interface PublicPOSPaycodeOverlayProps {
  onClose: () => void
  username: string
}

export default function PublicPOSPaycodeOverlay({
  onClose,
  username,
}: PublicPOSPaycodeOverlayProps) {
  // Username already validated by the public POS dashboard — skip re-validation.
  return (
    <PrintPaycodeView
      username={username}
      onBack={onClose}
      title="Paycodes"
      skipValidation
    />
  )
}
