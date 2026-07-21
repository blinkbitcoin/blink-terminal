/**
 * PaycodesOverlay - Authenticated Settings → Paycodes menu.
 *
 * Thin wrapper around the shared PrintPaycodeView so the Paycodes menu and the
 * standalone `/[username]/print` page are identical. Variable-amount only (the
 * fixed-amount input was removed when the two were unified).
 */
import PrintPaycodeView from "../PublicPOS/PrintPaycodeView"

interface PaycodesOverlayProps {
  username: string
  onBack: () => void
}

export default function PaycodesOverlay({ username, onBack }: PaycodesOverlayProps) {
  return <PrintPaycodeView username={username} onBack={onBack} title="Paycodes" />
}
