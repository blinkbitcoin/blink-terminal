/**
 * Payer memo for a voucher redemption. Written to the voucher wallet's
 * outgoing Blink transaction by the LNURL-withdraw callback, and matched
 * exactly by scripts/reconcile-voucher-claims.js (keep its buildVoucherMemo
 * in sync — tests/unit/voucher-reconcile.spec.ts asserts parity).
 */

interface VoucherMemoFields {
  amount: number
  walletCurrency?: string | null
  usdAmountCents?: number | null
  displayAmount?: string | null
  displayCurrency?: string | null
  commissionPercent?: number | null
}

export function buildVoucherMemo(voucher: VoucherMemoFields): string {
  const isUsdVoucher = voucher.walletCurrency === "USD"

  if (isUsdVoucher && voucher.usdAmountCents) {
    // USD voucher - show USD value prominently
    const usdAmount = (voucher.usdAmountCents / 100).toFixed(2)
    if (
      voucher.displayAmount &&
      voucher.displayCurrency &&
      voucher.displayCurrency !== "USD"
    ) {
      // Display currency is different from USD (e.g., ARS)
      if (voucher.commissionPercent && voucher.commissionPercent > 0) {
        return `BlinkPOS USD Voucher: ${voucher.displayCurrency} ${voucher.displayAmount} (${voucher.commissionPercent}% commission) = $${usdAmount} USD`
      }
      return `BlinkPOS USD Voucher: ${voucher.displayCurrency} ${voucher.displayAmount} = $${usdAmount} USD`
    }
    return `BlinkPOS USD Voucher: $${usdAmount} USD = ${voucher.amount} sats`
  }

  if (voucher.displayAmount && voucher.displayCurrency) {
    // BTC voucher with display currency
    if (voucher.commissionPercent && voucher.commissionPercent > 0) {
      return `BlinkPOS Voucher: ${voucher.displayCurrency} ${voucher.displayAmount} (${voucher.commissionPercent}% commission) = ${voucher.amount} sats`
    }
    return `BlinkPOS Voucher: ${voucher.displayCurrency} ${voucher.displayAmount} = ${voucher.amount} sats`
  }

  return `BlinkPOS Voucher: ${voucher.amount} sats`
}
