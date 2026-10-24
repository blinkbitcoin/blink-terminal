import { Document, Page, Text, View, Image, StyleSheet } from "@react-pdf/renderer"
import React from "react"

import { safeImageSrc } from "./safe-image-src"

// --- Type Definitions ---

interface SettlementVia {
  __typename?: string
  preImage?: string
  transactionHash?: string
  counterPartyUsername?: string
}

interface InitiationVia {
  __typename?: string
  paymentHash?: string
  address?: string
  counterPartyUsername?: string
}

interface TransactionData {
  id: string
  direction: string
  status?: string
  amount?: string
  settlementCurrency?: string
  settlementAmount?: number
  settlementFee?: number
  settlementDisplayAmount?: number
  settlementDisplayCurrency?: string
  date?: string
  memo?: string
  initiationVia?: InitiationVia
  settlementVia?: SettlementVia
}

interface TransactionReceiptDocumentProps {
  transaction: TransactionData
  generatedAt?: string
  logoDataUrl?: string
}

interface StatusColors {
  bg: string
  text: string
}

// --- Styles ---

// Styles for a balanced single-page layout
const styles = StyleSheet.create({
  page: {
    backgroundColor: "#FFFFFF",
    padding: 40,
    fontFamily: "Helvetica",
  },
  // Header section with logo
  header: {
    alignItems: "center",
    marginBottom: 20,
    paddingBottom: 15,
    borderBottom: "2px solid #F7931A",
  },
  logo: {
    width: 160,
    height: 53,
    marginBottom: 10,
    objectFit: "contain",
  },
  receiptTitle: {
    fontSize: 22,
    fontWeight: "bold",
    color: "#333333",
    marginTop: 8,
    fontFamily: "Helvetica-Bold",
  },
  // Transaction status badge
  statusBadge: {
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 15,
    marginTop: 8,
  },
  statusText: {
    fontSize: 11,
    fontWeight: "bold",
    fontFamily: "Helvetica-Bold",
  },
  // Amount section
  amountSection: {
    alignItems: "center",
    marginVertical: 20,
    padding: 18,
    backgroundColor: "#FFF9F0",
    borderRadius: 8,
  },
  directionText: {
    fontSize: 12,
    color: "#666666",
    marginBottom: 6,
  },
  amountText: {
    fontSize: 32,
    fontWeight: "bold",
    color: "#333333",
    fontFamily: "Helvetica-Bold",
  },
  amountSubtext: {
    fontSize: 11,
    color: "#888888",
    marginTop: 4,
  },
  // Details section
  detailsSection: {
    marginTop: 15,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "bold",
    color: "#F7931A",
    marginBottom: 12,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderBottom: "1px solid #EEEEEE",
  },
  detailLabel: {
    fontSize: 10,
    color: "#666666",
    width: "30%",
  },
  detailValue: {
    fontSize: 10,
    color: "#333333",
    fontFamily: "Helvetica-Bold",
    width: "70%",
    textAlign: "right",
  },
  detailValueMono: {
    fontSize: 8,
    color: "#333333",
    fontFamily: "Courier",
    width: "70%",
    textAlign: "right",
  },
  // Proof of payment section
  proofSection: {
    marginTop: 18,
    padding: 12,
    backgroundColor: "#F8F8F8",
    borderRadius: 6,
    border: "1px solid #EEEEEE",
  },
  proofTitle: {
    fontSize: 10,
    fontWeight: "bold",
    color: "#666666",
    marginBottom: 8,
    fontFamily: "Helvetica-Bold",
  },
  proofRow: {
    marginBottom: 8,
  },
  proofLabel: {
    fontSize: 9,
    color: "#666666",
    marginBottom: 3,
  },
  proofValue: {
    fontSize: 7,
    color: "#333333",
    fontFamily: "Courier",
    lineHeight: 1.4,
  },
  // Footer
  footer: {
    marginTop: "auto",
    paddingTop: 15,
    borderTop: "1px solid #EEEEEE",
    alignItems: "center",
  },
  footerText: {
    fontSize: 9,
    color: "#999999",
    marginBottom: 4,
  },
  footerLink: {
    fontSize: 10,
    color: "#F7931A",
    fontFamily: "Helvetica-Bold",
  },
  generatedAt: {
    fontSize: 8,
    color: "#BBBBBB",
    marginTop: 10,
  },
})

// --- Helper Functions ---

// Get status badge colors
const getStatusColors = (status?: string): StatusColors => {
  switch (status?.toUpperCase()) {
    case "SUCCESS":
    case "SETTLED":
      return { bg: "#DEF7EC", text: "#03543F" }
    case "PENDING":
      return { bg: "#FEF3C7", text: "#92400E" }
    case "FAILED":
      return { bg: "#FEE2E2", text: "#991B1B" }
    default:
      return { bg: "#F3F4F6", text: "#374151" }
  }
}

// Format transaction type for display
const formatTransactionType = (
  settlementVia?: SettlementVia,
  initiationVia?: InitiationVia,
): string => {
  const type = settlementVia?.__typename || initiationVia?.__typename || ""
  if (type.includes("OnChain")) return "On-Chain (Bitcoin)"
  if (type.includes("Ln")) return "Lightning Network"
  if (type.includes("IntraLedger")) return "Blink Internal Transfer"
  return "Unknown"
}

// --- Component ---

// Transaction Receipt Document
export const TransactionReceiptDocument: React.FC<TransactionReceiptDocumentProps> = ({
  transaction,
  generatedAt,
  logoDataUrl,
}) => {
  const {
    id,
    direction,
    status,
    amount,
    settlementCurrency,
    settlementAmount,
    settlementFee,
    settlementDisplayAmount,
    settlementDisplayCurrency,
    date,
    memo,
    initiationVia,
    settlementVia,
  } = transaction

  const isReceive = direction === "RECEIVE"
  const statusColors = getStatusColors(status)
  const txType = formatTransactionType(settlementVia, initiationVia)

  // Format display amount (fiat) - primary amount
  const formatDisplayAmount = (): string => {
    if (settlementDisplayAmount !== undefined && settlementDisplayCurrency) {
      const absAmount = Math.abs(settlementDisplayAmount)

      if (settlementDisplayCurrency === "USD") {
        return `$${absAmount.toFixed(2)}`
      }
      // For other currencies
      return `${absAmount.toFixed(2)} ${settlementDisplayCurrency}`
    }
    // Fallback to pre-formatted amount (without sign)
    if (amount) {
      return amount.replace(/^[+-]/, "")
    }
    return ""
  }

  // Format settlement amount (sats/USD) - secondary amount
  const formatSettlementAmount = (): string | null => {
    if (settlementAmount === undefined) return null
    const absAmount = Math.abs(settlementAmount)

    if (settlementCurrency === "BTC") {
      return `${absAmount.toLocaleString()} sats`
    } else if (settlementCurrency === "USD") {
      return `$${(absAmount / 100).toFixed(2)} USD`
    }
    return `${absAmount.toLocaleString()} ${settlementCurrency}`
  }

  // Determine if we should show secondary amount
  const shouldShowSecondaryAmount = (): boolean => {
    if (!settlementDisplayCurrency || !settlementCurrency) return false
    if (settlementCurrency === "BTC") return true
    return settlementDisplayCurrency !== settlementCurrency
  }

  const primaryAmount = formatDisplayAmount()
  const secondaryAmount = shouldShowSecondaryAmount() ? formatSettlementAmount() : null

  // Extract relevant technical details
  const paymentHash =
    initiationVia?.__typename === "InitiationViaLn" ? initiationVia.paymentHash : null

  const preimage =
    settlementVia?.__typename === "SettlementViaLn" ||
    settlementVia?.__typename === "SettlementViaIntraLedger"
      ? settlementVia.preImage
      : null

  const onChainHash =
    settlementVia?.__typename === "SettlementViaOnChain"
      ? settlementVia.transactionHash
      : null

  const onChainAddress =
    initiationVia?.__typename === "InitiationViaOnChain" ? initiationVia.address : null

  // Get counterparty without @ prefix
  const counterparty =
    settlementVia?.__typename === "SettlementViaIntraLedger"
      ? settlementVia.counterPartyUsername
      : initiationVia?.__typename === "InitiationViaIntraLedger"
        ? initiationVia.counterPartyUsername
        : null

  // Format fee
  const formatFee = (): string | null => {
    if (settlementFee === undefined || settlementFee === null || isReceive) return null
    if (settlementCurrency === "BTC") {
      return `${Math.abs(settlementFee).toLocaleString()} sats`
    } else if (settlementCurrency === "USD") {
      return `$${(Math.abs(settlementFee) / 100).toFixed(2)}`
    }
    return `${Math.abs(settlementFee)} ${settlementCurrency}`
  }

  const fee = formatFee()
  const hasProofData = preimage || onChainHash || paymentHash || onChainAddress

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* Header with Logo */}
        <View style={styles.header}>
          {safeImageSrc(logoDataUrl) && (
            <Image src={safeImageSrc(logoDataUrl)} style={styles.logo} />
          )}
          <Text style={styles.receiptTitle}>Payment Receipt</Text>
          <View style={[styles.statusBadge, { backgroundColor: statusColors.bg }]}>
            <Text style={[styles.statusText, { color: statusColors.text }]}>
              {status || "COMPLETED"}
            </Text>
          </View>
        </View>

        {/* Amount Section */}
        <View style={styles.amountSection}>
          <Text style={styles.directionText}>
            {isReceive ? "Amount Received" : "Amount Sent"}
          </Text>
          <Text style={styles.amountText}>{primaryAmount}</Text>
          {secondaryAmount && <Text style={styles.amountSubtext}>{secondaryAmount}</Text>}
        </View>

        {/* Transaction Details */}
        <View style={styles.detailsSection}>
          <Text style={styles.sectionTitle}>Transaction Details</Text>

          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Date & Time</Text>
            <Text style={styles.detailValue}>{date}</Text>
          </View>

          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Type</Text>
            <Text style={styles.detailValue}>{txType}</Text>
          </View>

          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Direction</Text>
            <Text style={styles.detailValue}>{isReceive ? "Received" : "Sent"}</Text>
          </View>

          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Account</Text>
            <Text style={styles.detailValue}>
              {settlementCurrency === "BTC" ? "BTC Wallet" : "USD Wallet"}
            </Text>
          </View>

          {fee && (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Network Fee</Text>
              <Text style={styles.detailValue}>{fee}</Text>
            </View>
          )}

          {counterparty && (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>{isReceive ? "From" : "To"}</Text>
              <Text style={styles.detailValue}>{counterparty}</Text>
            </View>
          )}

          {memo && memo !== "-" && (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Description</Text>
              <Text style={styles.detailValue}>{memo}</Text>
            </View>
          )}

          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Transaction ID</Text>
            <Text style={styles.detailValueMono}>{id}</Text>
          </View>
        </View>

        {/* Proof of Payment Section */}
        {hasProofData && (
          <View style={styles.proofSection}>
            <Text style={styles.proofTitle}>Proof of Payment</Text>

            {preimage && (
              <View style={styles.proofRow}>
                <Text style={styles.proofLabel}>Preimage:</Text>
                <Text style={styles.proofValue}>{preimage}</Text>
              </View>
            )}

            {paymentHash && (
              <View style={styles.proofRow}>
                <Text style={styles.proofLabel}>Payment Hash:</Text>
                <Text style={styles.proofValue}>{paymentHash}</Text>
              </View>
            )}

            {onChainHash && (
              <View style={styles.proofRow}>
                <Text style={styles.proofLabel}>Bitcoin Transaction:</Text>
                <Text style={styles.proofValue}>{onChainHash}</Text>
              </View>
            )}

            {onChainAddress && (
              <View style={[styles.proofRow, { marginBottom: 0 }]}>
                <Text style={styles.proofLabel}>Bitcoin Address:</Text>
                <Text style={styles.proofValue}>{onChainAddress}</Text>
              </View>
            )}
          </View>
        )}

        {/* Footer */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>
            This receipt was generated by Blink Wallet
          </Text>
          <Text style={styles.footerLink}>blink.sv</Text>
          <Text style={styles.generatedAt}>
            Generated on {generatedAt || new Date().toLocaleString()}
          </Text>
        </View>
      </Page>
    </Document>
  )
}

export default TransactionReceiptDocument
