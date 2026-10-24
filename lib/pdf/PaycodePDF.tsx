import { Document, Page, Text, View, Image, StyleSheet } from "@react-pdf/renderer"
import React from "react"

import { safeImageSrc } from "./safe-image-src"

// --- Type Definitions ---

interface PaperFormat {
  width: number
  height: number
}

interface PaycodeData {
  lightningAddress: string
  /** Server-generated QR (pages/api/paycode/pdf.ts), never caller-supplied. */
  qrDataUrl: string
  /** Server-owned centre logo, drawn over the QR. */
  logoDataUrl?: string
  amount?: number
  displayAmount?: string
  webUrl?: string
  username?: string
}

interface PaycodeDocumentProps {
  paycode: PaycodeData
}

// --- Constants ---

// Paper format configurations
export const PAPER_FORMATS: Record<string, PaperFormat> = {
  a4: { width: 595, height: 842 },
  letter: { width: 612, height: 792 },
}

// Get available formats for validation
export const getAvailableFormats = (): string[] => Object.keys(PAPER_FORMATS)

// Centre logo, same proportions as the client's canvas composite
// (components/PublicPOS/PrintPaycodeView.tsx): 22% of the QR, white backing
// padded by 8% of the logo. Error-correction level H tolerates the cover.
const QR_SIZE = 320
const LOGO_SIZE = QR_SIZE * 0.22
const LOGO_PAD = LOGO_SIZE * 0.08
const LOGO_BOX = LOGO_SIZE + LOGO_PAD * 2

// Styles for Paycode PDF — mirrors the on-screen "Print QR Code" poster:
// black/white/gray only, centered QR with the Bitcoin logo over its centre.
// No purple/yellow accents.
const styles = StyleSheet.create({
  page: {
    backgroundColor: "#FFFFFF",
    padding: 48,
    fontFamily: "Helvetica",
    alignItems: "center",
    justifyContent: "center",
  },
  container: {
    alignItems: "center",
    maxWidth: 520,
  },
  // Header: "Pay <lightningAddress>"
  title: {
    fontSize: 28,
    fontWeight: "bold",
    color: "#000000",
    fontFamily: "Helvetica-Bold",
    marginBottom: 8,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 16,
    color: "#000000",
    textAlign: "center",
    marginBottom: 24,
  },
  // Amount display (if fixed amount)
  amountSection: {
    alignItems: "center",
    marginBottom: 20,
    padding: 12,
    backgroundColor: "#F3F4F6",
    borderRadius: 8,
  },
  amountLabel: {
    fontSize: 12,
    color: "#666666",
    marginBottom: 4,
  },
  amountValue: {
    fontSize: 24,
    fontWeight: "bold",
    color: "#000000",
    fontFamily: "Helvetica-Bold",
  },
  // QR code section
  qrSection: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    padding: 16,
  },
  qrCode: {
    width: QR_SIZE,
    height: QR_SIZE,
  },
  qrFrame: {
    position: "relative",
    width: QR_SIZE,
    height: QR_SIZE,
  },
  logoBox: {
    position: "absolute",
    left: (QR_SIZE - LOGO_BOX) / 2,
    top: (QR_SIZE - LOGO_BOX) / 2,
    width: LOGO_BOX,
    height: LOGO_BOX,
    padding: LOGO_PAD,
    backgroundColor: "#FFFFFF",
  },
  logo: {
    width: LOGO_SIZE,
    height: LOGO_SIZE,
  },
  // Instructions (plain, no colored box)
  instructionsText: {
    fontSize: 13,
    color: "#000000",
    textAlign: "center",
    lineHeight: 1.4,
    marginTop: 24,
    maxWidth: 520,
  },
  instructionsTitle: {
    fontFamily: "Helvetica-Bold",
  },
})

/**
 * Paycode PDF Document
 * Generates a printable PDF with a Lightning paycode QR
 */
export const PaycodeDocument: React.FC<PaycodeDocumentProps> = ({ paycode }) => {
  const { lightningAddress, qrDataUrl, logoDataUrl, amount, displayAmount, username } =
    paycode

  const hasFixedAmount = amount && amount > 0
  const payee = username || lightningAddress.split("@")[0]

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.container}>
          {/* Header — matches the on-screen print poster */}
          <Text style={styles.title}>Pay {lightningAddress}</Text>
          <Text style={styles.subtitle}>
            Scan to pay {payee.toLowerCase()} with any Lightning wallet.
          </Text>

          {/* Fixed Amount (if set) */}
          {hasFixedAmount && (
            <View style={styles.amountSection}>
              <Text style={styles.amountLabel}>Amount to Pay</Text>
              <Text style={styles.amountValue}>{displayAmount || `${amount} sats`}</Text>
            </View>
          )}

          {/* QR Code with the Bitcoin logo over its centre */}
          <View style={styles.qrSection}>
            {safeImageSrc(qrDataUrl) && (
              <View style={styles.qrFrame}>
                <Image style={styles.qrCode} src={safeImageSrc(qrDataUrl)} />
                {safeImageSrc(logoDataUrl) && (
                  <View style={styles.logoBox}>
                    {/* react-pdf <Image> (PDF), not an HTML <img>: no alt prop */}
                    {/* eslint-disable-next-line jsx-a11y/alt-text */}
                    <Image style={styles.logo} src={safeImageSrc(logoDataUrl)} />
                  </View>
                )}
              </View>
            )}
          </View>

          {/* Instructions — plain, no colored box */}
          <Text style={styles.instructionsText}>
            <Text style={styles.instructionsTitle}>Having trouble scanning?</Text> Some
            wallets do not support printed QR codes. Scan with your phone&apos;s camera
            app to open a webpage where you can create a fresh invoice for paying from any
            Lightning wallet.
          </Text>
        </View>
      </Page>
    </Document>
  )
}

export default PaycodeDocument
