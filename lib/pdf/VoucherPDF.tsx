import { Document, Page, Text, View, Image, StyleSheet } from "@react-pdf/renderer"
import type { Style } from "@react-pdf/types/style"
import React from "react"

import { safeImageSrc } from "./safe-image-src"

/**
 * PDF style record — maps style names to react-pdf Style objects.
 * Replaces Record<string, any> for type safety.
 */
type PDFStyles = Record<string, Style>

// --- Type Definitions ---

interface PaperFormat {
  width: number
  height: number
  vouchersPerPage?: number
  columns?: number
  rows?: number
}

interface GridConfig {
  columns: number
  rows: number
  vouchersPerPage: number
  qrSize: number
  label: string
}

interface VoucherData {
  logoDataUrl?: string
  qrDataUrl?: string
  satsAmount?: number | string
  fiatAmount?: string
  usdAmountCents?: number
  walletCurrency?: string
  identifierCode?: string
  voucherSecret?: string
  commissionPercent?: number
  expiresAt?: string
  issuedBy?: string
  lnurl?: string
}

interface VoucherCardProps {
  voucher: VoucherData
  format: string
  styles: PDFStyles
}

interface SingleVoucherDocumentProps {
  voucher: VoucherData
  format?: string
}

interface BatchVoucherDocumentProps {
  vouchers: VoucherData[]
  format?: string
}

interface ThermalVoucherDocumentProps {
  voucher: VoucherData
  format?: string
}

interface ReissueVoucherCardProps {
  voucher: VoucherData
  styles: PDFStyles
}

interface ReissueVoucherDocumentProps {
  voucher: VoucherData
  format?: string
}

interface GridVoucherDocumentProps {
  vouchers: VoucherData[]
  gridSize?: string
  paperFormat?: string
}

// --- Constants ---

// Paper format configurations
export const PAPER_FORMATS: Record<string, PaperFormat> = {
  "a4": { width: 595, height: 842, vouchersPerPage: 4, columns: 2, rows: 2 },
  "letter": { width: 612, height: 792, vouchersPerPage: 4, columns: 2, rows: 2 },
  "thermal-80": { width: 227, height: 450, vouchersPerPage: 1, columns: 1, rows: 1 },
  "thermal-58": { width: 164, height: 350, vouchersPerPage: 1, columns: 1, rows: 1 },
}

// Grid configurations for multi-voucher printing
export const GRID_CONFIGS: Record<string, GridConfig> = {
  "2x2": {
    columns: 2,
    rows: 2,
    vouchersPerPage: 4,
    qrSize: 180,
    label: "2×2 (4 per page)",
  },
  "2x3": {
    columns: 2,
    rows: 3,
    vouchersPerPage: 6,
    qrSize: 140,
    label: "2×3 (6 per page)",
  },
  "3x3": {
    columns: 3,
    rows: 3,
    vouchersPerPage: 9,
    qrSize: 110,
    label: "3×3 (9 per page)",
  },
  "3x4": {
    columns: 3,
    rows: 4,
    vouchersPerPage: 12,
    qrSize: 90,
    label: "3×4 (12 per page)",
  },
}

// Get available grid configurations
export const getAvailableGrids = (): string[] => Object.keys(GRID_CONFIGS)

// Get available formats for validation
export const getAvailableFormats = (): string[] => Object.keys(PAPER_FORMATS)

// --- Internal Helper Functions ---

// Styles matching the Blink voucher app printout
const createStyles = (format: string): PDFStyles => {
  const isThermal = format.startsWith("thermal")
  const is58mm = format === "thermal-58"

  // Scale factors for different formats
  const scale = is58mm ? 0.7 : isThermal ? 0.85 : 1

  return StyleSheet.create({
    page: {
      backgroundColor: "#FFFFFF",
      padding: isThermal ? 8 : 15,
      fontFamily: "Helvetica",
    },
    // Grid layout for standard paper
    grid: {
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "space-around",
      alignItems: "flex-start",
    },
    // Individual voucher card
    voucherCard: {
      width: isThermal ? "100%" : "46%",
      marginBottom: isThermal ? 0 : 15,
      padding: isThermal ? 5 : 12,
      border: isThermal ? "none" : "1px dashed #999999",
    },
    // Header with Blink logo
    header: {
      alignItems: "center",
      marginBottom: 10 * scale,
    },
    logo: {
      width: isThermal ? 120 * scale : 150,
      height: isThermal ? 50 * scale : 62,
    },
    // Info section (Price, Value, Identifier, Commission)
    infoSection: {
      marginBottom: 8 * scale,
      paddingHorizontal: 5,
    },
    infoRow: {
      flexDirection: "row",
      justifyContent: "flex-start",
      marginBottom: 3 * scale,
    },
    infoLabel: {
      fontSize: isThermal ? 9 * scale : 11,
      color: "#000000",
      width: isThermal ? 70 * scale : 80,
    },
    infoValue: {
      fontSize: isThermal ? 9 * scale : 11,
      fontWeight: "bold",
      color: "#000000",
      fontFamily: "Helvetica-Bold",
    },
    // Dashed separator
    dashedLine: {
      borderBottom: "1px dashed #666666",
      marginVertical: 6 * scale,
    },
    // QR code section
    qrSection: {
      alignItems: "center",
      marginVertical: 8 * scale,
    },
    qrCode: {
      width: isThermal ? 160 * scale : 200,
      height: isThermal ? 160 * scale : 200,
    },
    // Voucher secret section
    secretSection: {
      alignItems: "center",
      marginVertical: 6 * scale,
      paddingVertical: 6 * scale,
      borderTop: "1px dashed #666666",
      borderBottom: "1px dashed #666666",
    },
    secretLabel: {
      fontSize: isThermal ? 8 * scale : 10,
      color: "#000000",
      marginBottom: 2,
    },
    secretCode: {
      fontSize: isThermal ? 12 * scale : 16,
      fontWeight: "bold",
      color: "#000000",
      fontFamily: "Helvetica-Bold",
      letterSpacing: 1,
    },
    // Footer with website
    footer: {
      alignItems: "center",
      marginTop: 8 * scale,
    },
    footerText: {
      fontSize: isThermal ? 9 * scale : 11,
      color: "#000000",
    },
    // Retention notice for value stability
    retentionNotice: {
      fontSize: isThermal ? 6 * scale : 8,
      color: "#666666",
      textAlign: "center",
      marginTop: 4 * scale,
      fontStyle: "italic",
    },
    // Cut line for thermal
    cutLine: {
      borderTop: "1px dashed #999999",
      marginTop: 10,
      paddingTop: 3,
    },
    cutText: {
      fontSize: 6,
      color: "#999999",
      textAlign: "center",
    },
  })
}

// Create styles for grid-based multi-voucher layouts
const createGridStyles = (
  gridConfig: GridConfig,
  paperFormat: string = "a4",
): PDFStyles => {
  const { columns, rows, qrSize } = gridConfig
  const paper = PAPER_FORMATS[paperFormat] || PAPER_FORMATS.a4

  // Calculate available space
  const pagePadding = 15
  const availableWidth = paper.width - pagePadding * 2
  const availableHeight = paper.height - pagePadding * 2

  // Calculate card dimensions based on grid
  const cardWidth = Math.floor(availableWidth / columns) - 8
  const cardHeight = Math.floor(availableHeight / rows) - 8

  // Scale factor based on grid density
  const densityScale = columns === 2 ? 1 : columns === 3 ? 0.75 : 0.6

  return StyleSheet.create({
    page: {
      backgroundColor: "#FFFFFF",
      padding: pagePadding,
      fontFamily: "Helvetica",
    },
    grid: {
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "space-between",
      alignContent: "flex-start",
    },
    voucherCard: {
      width: cardWidth,
      height: cardHeight,
      marginBottom: 4,
      padding: 6 * densityScale,
      border: "1px dashed #999999",
    },
    header: {
      alignItems: "center",
      marginBottom: 4 * densityScale,
    },
    logo: {
      width: 100 * densityScale,
      height: 41 * densityScale,
    },
    infoSection: {
      marginBottom: 4 * densityScale,
      paddingHorizontal: 2,
    },
    infoRow: {
      flexDirection: "row",
      justifyContent: "flex-start",
      marginBottom: 1,
    },
    infoLabel: {
      fontSize: 8 * densityScale,
      color: "#000000",
      width: 50 * densityScale,
    },
    infoValue: {
      fontSize: 8 * densityScale,
      fontWeight: "bold",
      color: "#000000",
      fontFamily: "Helvetica-Bold",
    },
    dashedLine: {
      borderBottom: "1px dashed #666666",
      marginVertical: 3 * densityScale,
    },
    qrSection: {
      alignItems: "center",
      marginVertical: 4 * densityScale,
    },
    qrCode: {
      width: qrSize,
      height: qrSize,
    },
    secretSection: {
      alignItems: "center",
      marginVertical: 3 * densityScale,
      paddingVertical: 3 * densityScale,
      borderTop: "1px dashed #666666",
      borderBottom: "1px dashed #666666",
    },
    secretLabel: {
      fontSize: 6 * densityScale,
      color: "#000000",
      marginBottom: 1,
    },
    secretCode: {
      fontSize: 10 * densityScale,
      fontWeight: "bold",
      color: "#000000",
      fontFamily: "Helvetica-Bold",
      letterSpacing: 0.5,
    },
    footer: {
      alignItems: "center",
      marginTop: 4 * densityScale,
    },
    footerText: {
      fontSize: 7 * densityScale,
      color: "#000000",
    },
    retentionNotice: {
      fontSize: 5 * densityScale,
      color: "#666666",
      textAlign: "center",
      marginTop: 2 * densityScale,
      fontStyle: "italic",
    },
  })
}

// Format voucher secret for display (e.g., "q6pv Y79E ftnZ")
const formatVoucherSecret = (secret?: string): string => {
  if (!secret) return ""
  // Split into groups of 4 characters
  const cleaned = secret.replace(/[^a-zA-Z0-9]/g, "")
  const groups: string[] = []
  for (let i = 0; i < cleaned.length && groups.length < 3; i += 4) {
    groups.push(cleaned.slice(i, i + 4))
  }
  return groups.join(" ")
}

// Format expiry date for PDF display
const formatExpiryForPdf = (expiresAt?: string): string | null => {
  if (!expiresAt) return null
  const date = new Date(expiresAt)
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

// --- Internal Components ---

// Voucher Card Component - matching Blink voucher app layout
const VoucherCard: React.FC<VoucherCardProps> = ({
  voucher,
  format: _format,
  styles,
}) => {
  const formattedSecret = formatVoucherSecret(
    voucher.voucherSecret || voucher.identifierCode,
  )
  const formattedExpiry = formatExpiryForPdf(voucher.expiresAt)
  const isUsdVoucher = voucher.walletCurrency === "USD"
  const isBtcDisplayCurrency =
    !voucher.fiatAmount ||
    (voucher.fiatAmount &&
      (voucher.fiatAmount.includes("BTC") || voucher.fiatAmount.includes("sats")))

  // Format USD amount for display
  const formatUsdAmount = (cents?: number): string | null => {
    if (!cents) return null
    return `$${(cents / 100).toFixed(2)} USD`
  }

  // Get retention notice text based on voucher type
  const getRetentionNotice = (): string => {
    if (isUsdVoucher) {
      return "Value retained in USD until redemption or expiry"
    }
    return "Value retained in sats until redemption or expiry"
  }

  return (
    <View style={styles.voucherCard}>
      {/* Header with Blink Logo */}
      <View style={styles.header}>
        {safeImageSrc(voucher.logoDataUrl) && (
          <Image src={safeImageSrc(voucher.logoDataUrl)} style={styles.logo} />
        )}
      </View>

      {/* Info Section */}
      <View style={styles.infoSection}>
        {isUsdVoucher && voucher.usdAmountCents ? (
          <>
            {/* USD Voucher: Show USD value as primary (commission already deducted) */}
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Value:</Text>
              <Text style={styles.infoValue}>
                {formatUsdAmount(voucher.usdAmountCents)}
              </Text>
            </View>

            {/* Show Price in display currency */}
            {voucher.fiatAmount && !voucher.fiatAmount.includes("$") ? (
              // Normal case: show display currency as Price (without commission)
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Price:</Text>
                <Text style={styles.infoValue}>{voucher.fiatAmount}</Text>
              </View>
            ) : isBtcDisplayCurrency && (voucher.commissionPercent ?? 0) > 0 ? (
              // Edge case: BTC display + USD voucher with commission - show original USD price
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Price:</Text>
                <Text style={styles.infoValue}>
                  {formatUsdAmount(
                    Math.round(
                      voucher.usdAmountCents /
                        (1 - (voucher.commissionPercent ?? 0) / 100),
                    ),
                  )}
                </Text>
              </View>
            ) : null}
          </>
        ) : (
          <>
            {/* BTC Voucher */}
            {!isBtcDisplayCurrency && voucher.fiatAmount ? (
              // Fiat display + BTC voucher: show Price (fiat) first, then Value (sats)
              <>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Price:</Text>
                  <Text style={styles.infoValue}>{voucher.fiatAmount}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Value:</Text>
                  <Text style={styles.infoValue}>{voucher.satsAmount} sats</Text>
                </View>
              </>
            ) : (
              // BTC display + BTC voucher: only show Value (sats), no Price
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Value:</Text>
                <Text style={styles.infoValue}>{voucher.satsAmount} sats</Text>
              </View>
            )}
          </>
        )}

        {/* Identifier */}
        {voucher.identifierCode && (
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Identifier:</Text>
            <Text style={styles.infoValue}>{voucher.identifierCode.toUpperCase()}</Text>
          </View>
        )}

        {/* Commission (if applicable) */}
        {(voucher.commissionPercent ?? 0) > 0 && (
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Commission:</Text>
            <Text style={styles.infoValue}>{voucher.commissionPercent}%</Text>
          </View>
        )}

        {/* Valid Until (expiry date) */}
        {formattedExpiry && (
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Valid until:</Text>
            <Text style={styles.infoValue}>{formattedExpiry}</Text>
          </View>
        )}

        {/* Issued By (username) */}
        {voucher.issuedBy && (
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Issued by:</Text>
            <Text style={styles.infoValue}>{voucher.issuedBy}</Text>
          </View>
        )}
      </View>

      {/* Dashed separator */}
      <View style={styles.dashedLine} />

      {/* QR Code */}
      <View style={styles.qrSection}>
        {safeImageSrc(voucher.qrDataUrl) && (
          <Image src={safeImageSrc(voucher.qrDataUrl)} style={styles.qrCode} />
        )}
      </View>

      {/* Voucher Secret */}
      {formattedSecret && (
        <View style={styles.secretSection}>
          <Text style={styles.secretLabel}>voucher secret</Text>
          <Text style={styles.secretCode}>{formattedSecret}</Text>
        </View>
      )}

      {/* Footer */}
      <View style={styles.footer}>
        <Text style={styles.footerText}>blink.sv</Text>
        {styles.retentionNotice && (
          <Text style={styles.retentionNotice}>{getRetentionNotice()}</Text>
        )}
      </View>
    </View>
  )
}

// Create styles for reissue voucher (includes LNURL text)
const createReissueStyles = (format: string = "a4"): PDFStyles => {
  const _paper = PAPER_FORMATS[format] || PAPER_FORMATS.a4

  return StyleSheet.create({
    page: {
      backgroundColor: "#FFFFFF",
      padding: 30,
      fontFamily: "Helvetica",
    },
    container: {
      flex: 1,
      alignItems: "center",
    },
    header: {
      alignItems: "center",
      marginBottom: 15,
    },
    logo: {
      width: 180,
      height: 75,
    },
    reissueLabel: {
      backgroundColor: "#F59E0B",
      paddingHorizontal: 12,
      paddingVertical: 4,
      borderRadius: 4,
      marginTop: 8,
    },
    reissueLabelText: {
      fontSize: 10,
      color: "#FFFFFF",
      fontFamily: "Helvetica-Bold",
      textTransform: "uppercase",
    },
    infoSection: {
      marginBottom: 15,
      paddingHorizontal: 10,
      width: "100%",
      maxWidth: 350,
    },
    infoRow: {
      flexDirection: "row",
      justifyContent: "flex-start",
      marginBottom: 4,
    },
    infoLabel: {
      fontSize: 11,
      color: "#000000",
      width: 90,
    },
    infoValue: {
      fontSize: 11,
      fontWeight: "bold",
      color: "#000000",
      fontFamily: "Helvetica-Bold",
    },
    dashedLine: {
      borderBottom: "1px dashed #666666",
      marginVertical: 10,
      width: "100%",
      maxWidth: 350,
    },
    qrSection: {
      alignItems: "center",
      marginVertical: 15,
    },
    qrCode: {
      width: 220,
      height: 220,
    },
    secretSection: {
      alignItems: "center",
      marginVertical: 10,
      paddingVertical: 8,
      borderTop: "1px dashed #666666",
      borderBottom: "1px dashed #666666",
      width: "100%",
      maxWidth: 350,
    },
    secretLabel: {
      fontSize: 10,
      color: "#000000",
      marginBottom: 3,
    },
    secretCode: {
      fontSize: 16,
      fontWeight: "bold",
      color: "#000000",
      fontFamily: "Helvetica-Bold",
      letterSpacing: 1,
    },
    // LNURL section - key addition for reissue
    lnurlSection: {
      marginTop: 15,
      padding: 12,
      backgroundColor: "#F3F4F6",
      borderRadius: 6,
      width: "100%",
      maxWidth: 500,
    },
    lnurlLabel: {
      fontSize: 9,
      color: "#6B7280",
      marginBottom: 6,
      textAlign: "center",
    },
    lnurlText: {
      fontSize: 7,
      color: "#111827",
      fontFamily: "Courier",
      textAlign: "center",
      lineHeight: 1.4,
      ...({ wordBreak: "break-all" } as Record<string, string>),
    },
    lnurlHint: {
      fontSize: 8,
      color: "#9CA3AF",
      marginTop: 8,
      textAlign: "center",
      fontStyle: "italic",
    },
    footer: {
      alignItems: "center",
      marginTop: 20,
    },
    footerText: {
      fontSize: 11,
      color: "#000000",
    },
  })
}

// Reissue Voucher Card Component - includes full LNURL for copying
const ReissueVoucherCard: React.FC<ReissueVoucherCardProps> = ({ voucher, styles }) => {
  const formattedSecret = formatVoucherSecret(
    voucher.voucherSecret || voucher.identifierCode,
  )
  const formattedExpiry = formatExpiryForPdf(voucher.expiresAt)
  const isUsdVoucher = voucher.walletCurrency === "USD"

  // Format USD amount for display
  const formatUsdAmount = (cents?: number): string | null => {
    if (!cents) return null
    return `$${(cents / 100).toFixed(2)} USD`
  }

  // Get retention notice text based on voucher type
  const getRetentionNotice = (): string => {
    if (isUsdVoucher) {
      return "Value retained in USD until redemption or expiry"
    }
    return "Value retained in sats until redemption or expiry"
  }

  return (
    <View style={styles.container}>
      {/* Header with Blink Logo */}
      <View style={styles.header}>
        {safeImageSrc(voucher.logoDataUrl) && (
          <Image src={safeImageSrc(voucher.logoDataUrl)} style={styles.logo} />
        )}
        <View style={styles.reissueLabel}>
          <Text style={styles.reissueLabelText}>
            {isUsdVoucher ? "Reissued USD Voucher" : "Reissued Voucher"}
          </Text>
        </View>
      </View>

      {/* Info Section */}
      <View style={styles.infoSection}>
        {isUsdVoucher && voucher.usdAmountCents ? (
          <>
            {/* USD Voucher: Show USD value as primary, display currency as price, omit sats */}
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Value:</Text>
              <Text style={styles.infoValue}>
                {formatUsdAmount(voucher.usdAmountCents)}
              </Text>
            </View>

            {/* Show display currency as "Price" if different from USD */}
            {voucher.fiatAmount && !voucher.fiatAmount.includes("$") && (
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Price:</Text>
                <Text style={styles.infoValue}>{voucher.fiatAmount}</Text>
              </View>
            )}
          </>
        ) : (
          <>
            {/* BTC Voucher: Show fiat price first (if available), then sats as value */}
            {voucher.fiatAmount && (
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Price:</Text>
                <Text style={styles.infoValue}>{voucher.fiatAmount}</Text>
              </View>
            )}

            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Value:</Text>
              <Text style={styles.infoValue}>{voucher.satsAmount} sats</Text>
            </View>
          </>
        )}

        {/* Identifier */}
        {voucher.identifierCode && (
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Identifier:</Text>
            <Text style={styles.infoValue}>{voucher.identifierCode.toUpperCase()}</Text>
          </View>
        )}

        {/* Commission (if applicable) */}
        {(voucher.commissionPercent ?? 0) > 0 && (
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Commission:</Text>
            <Text style={styles.infoValue}>{voucher.commissionPercent}%</Text>
          </View>
        )}

        {/* Valid Until (expiry date) */}
        {formattedExpiry && (
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Valid until:</Text>
            <Text style={styles.infoValue}>{formattedExpiry}</Text>
          </View>
        )}

        {/* Issued By (username) */}
        {voucher.issuedBy && (
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Issued by:</Text>
            <Text style={styles.infoValue}>{voucher.issuedBy}</Text>
          </View>
        )}

        {/* Retention notice */}
        <View style={[styles.infoRow, { marginTop: 8 }]}>
          <Text style={{ fontSize: 9, color: "#666666", fontStyle: "italic" }}>
            {getRetentionNotice()}
          </Text>
        </View>
      </View>

      {/* Dashed separator */}
      <View style={styles.dashedLine} />

      {/* QR Code */}
      <View style={styles.qrSection}>
        {safeImageSrc(voucher.qrDataUrl) && (
          <Image src={safeImageSrc(voucher.qrDataUrl)} style={styles.qrCode} />
        )}
      </View>

      {/* Voucher Secret */}
      {formattedSecret && (
        <View style={styles.secretSection}>
          <Text style={styles.secretLabel}>voucher secret</Text>
          <Text style={styles.secretCode}>{formattedSecret}</Text>
        </View>
      )}

      {/* LNURL Section - Full text for copying */}
      {voucher.lnurl && (
        <View style={styles.lnurlSection}>
          <Text style={styles.lnurlLabel}>LNURL-WITHDRAW CODE (for manual entry)</Text>
          <Text style={styles.lnurlText}>{voucher.lnurl}</Text>
          <Text style={styles.lnurlHint}>
            Copy this code to redeem in any Lightning wallet that supports LNURL
          </Text>
        </View>
      )}

      {/* Footer */}
      <View style={styles.footer}>
        <Text style={styles.footerText}>blink.sv</Text>
      </View>
    </View>
  )
}

// --- Exported Document Components ---

// Single Voucher Document (one voucher per page)
export const SingleVoucherDocument: React.FC<SingleVoucherDocumentProps> = ({
  voucher,
  format = "a4",
}) => {
  const paperConfig = PAPER_FORMATS[format] || PAPER_FORMATS.a4
  const styles = createStyles(format)

  return (
    <Document>
      <Page
        size={{ width: paperConfig.width, height: paperConfig.height }}
        style={styles.page}
      >
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
          <VoucherCard voucher={voucher} format={format} styles={styles} />
        </View>
      </Page>
    </Document>
  )
}

// Batch Voucher Document (multiple vouchers per page)
export const BatchVoucherDocument: React.FC<BatchVoucherDocumentProps> = ({
  vouchers,
  format = "a4",
}) => {
  const paperConfig = PAPER_FORMATS[format] || PAPER_FORMATS.a4
  const styles = createStyles(format)
  const isThermal = format.startsWith("thermal")

  if (isThermal) {
    // For thermal: one voucher per page
    return (
      <Document>
        {vouchers.map((voucher, index) => (
          <Page
            key={index}
            size={{ width: paperConfig.width, height: paperConfig.height }}
            style={styles.page}
          >
            <VoucherCard voucher={voucher} format={format} styles={styles} />
          </Page>
        ))}
      </Document>
    )
  }

  // For standard paper: grid layout
  const pages: VoucherData[][] = []
  for (let i = 0; i < vouchers.length; i += paperConfig.vouchersPerPage ?? 4) {
    pages.push(vouchers.slice(i, i + (paperConfig.vouchersPerPage ?? 4)))
  }

  return (
    <Document>
      {pages.map((pageVouchers, pageIndex) => (
        <Page
          key={pageIndex}
          size={{ width: paperConfig.width, height: paperConfig.height }}
          style={styles.page}
        >
          <View style={styles.grid}>
            {pageVouchers.map((voucher, vIndex) => (
              <VoucherCard
                key={vIndex}
                voucher={voucher}
                format={format}
                styles={styles}
              />
            ))}
          </View>
        </Page>
      ))}
    </Document>
  )
}

// Thermal Receipt Document
export const ThermalVoucherDocument: React.FC<ThermalVoucherDocumentProps> = ({
  voucher,
  format = "thermal-80",
}) => {
  const paperConfig = PAPER_FORMATS[format] || PAPER_FORMATS["thermal-80"]
  const styles = createStyles(format)

  return (
    <Document>
      <Page
        size={{ width: paperConfig.width, height: paperConfig.height }}
        style={styles.page}
      >
        <VoucherCard voucher={voucher} format={format} styles={styles} />
      </Page>
    </Document>
  )
}

// Reissue Voucher Document - single voucher with full LNURL for replacement/reissue
export const ReissueVoucherDocument: React.FC<ReissueVoucherDocumentProps> = ({
  voucher,
  format = "a4",
}) => {
  const paperConfig = PAPER_FORMATS[format] || PAPER_FORMATS.a4
  const styles = createReissueStyles(format)

  return (
    <Document>
      <Page
        size={{ width: paperConfig.width, height: paperConfig.height }}
        style={styles.page}
      >
        <ReissueVoucherCard voucher={voucher} styles={styles} />
      </Page>
    </Document>
  )
}

// Grid-based Multi-Voucher Document (configurable grid layout)
export const GridVoucherDocument: React.FC<GridVoucherDocumentProps> = ({
  vouchers,
  gridSize = "2x2",
  paperFormat = "a4",
}) => {
  const gridConfig = GRID_CONFIGS[gridSize] || GRID_CONFIGS["2x2"]
  const paperConfig = PAPER_FORMATS[paperFormat] || PAPER_FORMATS.a4
  const styles = createGridStyles(gridConfig, paperFormat)

  // Split vouchers into pages based on grid configuration
  const pages: VoucherData[][] = []
  for (let i = 0; i < vouchers.length; i += gridConfig.vouchersPerPage) {
    pages.push(vouchers.slice(i, i + gridConfig.vouchersPerPage))
  }

  return (
    <Document>
      {pages.map((pageVouchers, pageIndex) => (
        <Page
          key={pageIndex}
          size={{ width: paperConfig.width, height: paperConfig.height }}
          style={styles.page}
        >
          <View style={styles.grid}>
            {pageVouchers.map((voucher, vIndex) => (
              <VoucherCard
                key={vIndex}
                voucher={voucher}
                format={paperFormat}
                styles={styles}
              />
            ))}
          </View>
        </Page>
      ))}
    </Document>
  )
}
