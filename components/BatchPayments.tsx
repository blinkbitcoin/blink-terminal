import { useState, useCallback, useRef, useEffect, type JSX } from "react"

import { generateTemplate } from "../lib/batch-payments"
import { getApiUrl } from "../lib/config/api"

/**
 * Batch Payments Component
 *
 * Step-by-step batch payment flow:
 * 1. Upload CSV
 * 2. Validate recipients
 * 3. Review fees and confirm
 * 4. Execute payments
 * 5. View results
 */

// ============================================================================
// Types
// ============================================================================

const STEPS = {
  UPLOAD: "upload",
  VALIDATING: "validating",
  REVIEW: "review",
  CONFIRM: "confirm",
  EXECUTING: "executing",
  RESULTS: "results",
} as const

type StepValue = (typeof STEPS)[keyof typeof STEPS]

interface BatchPaymentsProps {
  apiKey: string
  walletId: string
  darkMode?: boolean
  onClose?: () => void
  hideHeader?: boolean
}

interface ProgressState {
  percent: number
  completed: number
  total: number
}

interface FeeBreakdownItem {
  count: number
  feesSats: number
}

interface FeeSummary {
  totalAmountSats: number
  totalFeesSats: number
  grandTotalSats: number
  breakdown: {
    intraLedger: FeeBreakdownItem
    external: FeeBreakdownItem
  }
}

interface ValidationResultEntry {
  valid: boolean
  recipient: string
  normalized?: string
  type?: string
  amountSats?: number
  amount?: number
  currency?: string
  memo?: string
  error?: { message: string }
  rowNumber?: number
}

interface ValidationSummary {
  valid: number
  invalid: number
  total: number
  totalAmountSats: number
  byType: Record<string, number>
}

interface ValidationResults {
  batchId?: string
  summary: ValidationSummary
  results: ValidationResultEntry[]
  parseErrors?: unknown[]
}

interface ExecutionResultEntry {
  rowNumber: number
  recipient: string
  normalized?: string
  type: string
  amountSats: number
  success: boolean
  error?: { message: string }
}

interface ExecutionSummary {
  totalRecipients: number
  successful: number
  failed: number
  totalSentSats: number
}

interface ExecutionResults {
  summary: ExecutionSummary
  results: ExecutionResultEntry[]
}

interface StepIndicatorItem {
  key: string
  label: string
}

/** Synthetic event shape for handleFileSelect when called from drag-and-drop */
interface FileSelectEvent {
  target: {
    files?: File[] | FileList | null
  }
}

// ============================================================================
// Component
// ============================================================================

export default function BatchPayments({
  apiKey,
  walletId,
  darkMode: _darkMode,
  onClose,
  hideHeader = false,
}: BatchPaymentsProps) {
  // Step state
  const [currentStep, setCurrentStep] = useState<StepValue>(STEPS.UPLOAD)

  // Data state
  const [csvContent, setCsvContent] = useState<string>("")
  const [fileName, setFileName] = useState<string>("")
  const [batchId, setBatchId] = useState<string | null>(null)
  const [validationResults, setValidationResults] = useState<ValidationResults | null>(
    null,
  )
  const [feeSummary, setFeeSummary] = useState<FeeSummary | null>(null)
  const [executionResults, setExecutionResults] = useState<ExecutionResults | null>(null)
  const [balanceSats, setBalanceSats] = useState<number | null>(null)

  // UI state
  const [error, setError] = useState<string>("")
  const [progress, setProgress] = useState<ProgressState>({
    percent: 0,
    completed: 0,
    total: 0,
  })
  const [simulatedProgress, setSimulatedProgress] = useState<number>(0)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Simulated progress animation for validation and execution
  useEffect(() => {
    if (currentStep === STEPS.VALIDATING || currentStep === STEPS.EXECUTING) {
      setSimulatedProgress(0)

      // Calculate estimated duration based on recipients count
      const recipientCount =
        currentStep === STEPS.EXECUTING
          ? progress.total
          : csvContent.split("\n").length - 1 // Rough estimate from CSV lines

      // ~150ms per recipient for execution, ~100ms for validation
      const msPerRecipient = currentStep === STEPS.EXECUTING ? 150 : 100
      const estimatedDurationMs = Math.max(2000, recipientCount * msPerRecipient)

      // Update progress every 50ms
      const intervalMs = 50
      const incrementPerInterval = 95 / (estimatedDurationMs / intervalMs) // Max 95% until done

      progressIntervalRef.current = setInterval(() => {
        setSimulatedProgress((prev) => {
          // Cap at 95% until actually done
          if (prev >= 95) {
            return 95
          }
          // Slow down as we approach 95%
          if (prev > 85) {
            return Math.min(95, prev + incrementPerInterval * 0.3)
          }
          return Math.min(95, prev + incrementPerInterval)
        })
      }, intervalMs)

      return () => {
        if (progressIntervalRef.current) {
          clearInterval(progressIntervalRef.current)
        }
      }
    } else {
      // Reset when leaving these steps
      setSimulatedProgress(0)
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current)
      }
    }
  }, [currentStep, progress.total, csvContent])

  // Fetch balance on mount
  useEffect(() => {
    async function fetchBalance(): Promise<void> {
      if (!apiKey) return

      try {
        const query = `
          query {
            me {
              defaultAccount {
                wallets {
                  id
                  walletCurrency
                  balance
                }
              }
            }
          }
        `

        const response = await fetch(getApiUrl(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-KEY": apiKey,
          },
          body: JSON.stringify({ query }),
        })

        if (response.ok) {
          const data: Record<string, unknown> = await response.json()
          const meData = data.data as Record<string, unknown> | undefined
          const accountData = (meData?.me as Record<string, unknown> | undefined)
            ?.defaultAccount as Record<string, unknown> | undefined
          const wallets: Array<{ walletCurrency: string; balance?: number }> =
            (accountData?.wallets as Array<{
              walletCurrency: string
              balance?: number
            }>) || []
          const btcWallet = wallets.find(
            (w: { walletCurrency: string; balance?: number }) =>
              w.walletCurrency === "BTC",
          )
          if (btcWallet) {
            setBalanceSats(btcWallet.balance ?? null)
          }
        }
      } catch (err: unknown) {
        console.error("Failed to fetch balance:", err)
      }
    }

    fetchBalance()
  }, [apiKey])

  // Handle file upload
  const handleFileSelect = useCallback((event: FileSelectEvent) => {
    const file = event.target.files?.[0]
    if (!file) return

    // Validate file type
    if (!file.name.endsWith(".csv")) {
      setError("Please upload a CSV file")
      return
    }

    // Validate file size (5MB max)
    if (file.size > 5 * 1024 * 1024) {
      setError("File too large. Maximum size is 5MB")
      return
    }

    const reader = new FileReader()
    reader.onload = (e: ProgressEvent<FileReader>) => {
      setCsvContent(e.target?.result as string)
      setFileName(file.name)
      setError("")
    }
    reader.onerror = () => {
      setError("Failed to read file")
    }
    reader.readAsText(file)
  }, [])

  // Handle drag and drop
  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      const file = event.dataTransfer.files?.[0]
      if (file) {
        // Create a synthetic event for handleFileSelect
        handleFileSelect({ target: { files: [file] } })
      }
    },
    [handleFileSelect],
  )

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
  }, [])

  // Validate recipients
  const handleValidate = useCallback(async () => {
    if (!csvContent) {
      setError("Please upload a CSV file first")
      return
    }

    setCurrentStep(STEPS.VALIDATING)
    setError("")

    try {
      const response = await fetch("/api/batch-payments/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvContent }),
      })

      const data = (await response.json()) as ValidationResults & { error?: string }

      if (!response.ok) {
        throw new Error(data.error || "Validation failed")
      }

      setBatchId(data.batchId as string)
      setValidationResults(data)

      // Calculate fee summary from valid recipients
      const validCount: number = data.summary.valid
      const totalAmount: number = data.summary.totalAmountSats

      // Estimate fees (0 for intra-ledger, ~0.3% for external)
      const blinkCount: number = data.summary.byType.BLINK || 0
      const externalCount = validCount - blinkCount
      const externalAmount = Math.round(totalAmount * (externalCount / validCount)) || 0
      const estimatedFees = Math.ceil(externalAmount * 0.003)

      setFeeSummary({
        totalAmountSats: totalAmount,
        totalFeesSats: estimatedFees,
        grandTotalSats: totalAmount + estimatedFees,
        breakdown: {
          intraLedger: { count: blinkCount, feesSats: 0 },
          external: { count: externalCount, feesSats: estimatedFees },
        },
      })

      setCurrentStep(STEPS.REVIEW)
    } catch (err: unknown) {
      console.error("Validation error:", err)
      setError((err as Error).message)
      setCurrentStep(STEPS.UPLOAD)
    }
  }, [csvContent])

  // Execute payments
  const handleExecute = useCallback(async () => {
    if (!apiKey || !walletId) {
      setError("Missing required payment credentials")
      return
    }

    if (!validationResults?.results) {
      setError("No validation results. Please re-validate your CSV.")
      return
    }

    // Get valid recipients from validation results
    const validRecipients = validationResults.results.filter((r) => r.valid)
    if (validRecipients.length === 0) {
      setError("No valid recipients to pay")
      return
    }

    setCurrentStep(STEPS.EXECUTING)
    setError("")
    setProgress({ percent: 0, completed: 0, total: validRecipients.length })

    try {
      // Pass validation results directly (flat structure expected by executor)
      // The executor accesses: validationResult.recipient (original string),
      // validationResult.amountSats, validationResult.memo, etc.
      const response = await fetch("/api/batch-payments/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey,
          walletId,
          validationResults: validRecipients,
          confirm: true,
        }),
      })

      const data = (await response.json()) as ExecutionResults & { error?: string }

      if (!response.ok) {
        throw new Error(data.error || "Execution failed")
      }

      setExecutionResults(data)
      setCurrentStep(STEPS.RESULTS)
    } catch (err: unknown) {
      console.error("Execution error:", err)
      setError((err as Error).message)
      setCurrentStep(STEPS.CONFIRM)
    }
  }, [apiKey, walletId, validationResults])

  // Download CSV template
  const handleDownloadTemplate = useCallback(() => {
    try {
      const template = generateTemplate()
      const blob = new Blob([template], { type: "text/csv" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = "batch-payment-template.csv"
      a.style.display = "none"
      document.body.appendChild(a)
      a.click()
      // Defer cleanup so the browser finishes initiating the download
      // before the element is removed (fixes Chrome freeze with fixed overlays)
      requestAnimationFrame(() => {
        document.body.removeChild(a)
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      })
    } catch (err) {
      console.error("Failed to download template:", err)
      setError("Failed to download template. Please try again.")
    }
  }, [])

  // Download results CSV
  const handleDownloadResults = useCallback(() => {
    if (!executionResults?.results) return

    try {
      const header = "row,recipient,type,amount_sats,success,error\n"
      const rows = executionResults.results
        .map(
          (r) =>
            `${r.rowNumber},"${r.recipient}",${r.type},${r.amountSats},${r.success},"${r.error?.message || ""}"`,
        )
        .join("\n")

      const blob = new Blob([header + rows], { type: "text/csv" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `batch-results-${batchId}.csv`
      a.style.display = "none"
      document.body.appendChild(a)
      a.click()
      requestAnimationFrame(() => {
        document.body.removeChild(a)
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      })
    } catch (err) {
      console.error("Failed to download results:", err)
      setError("Failed to download results. Please try again.")
    }
  }, [executionResults, batchId])

  // Reset to start new batch
  const handleReset = useCallback(() => {
    setCsvContent("")
    setFileName("")
    setBatchId(null)
    setValidationResults(null)
    setFeeSummary(null)
    setExecutionResults(null)
    setError("")
    setProgress({ percent: 0, completed: 0, total: 0 })
    setCurrentStep(STEPS.UPLOAD)
    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }
  }, [])

  // Render step indicator
  const renderStepIndicator = (): JSX.Element => {
    const steps: StepIndicatorItem[] = [
      { key: STEPS.UPLOAD, label: "Upload" },
      { key: STEPS.REVIEW, label: "Review" },
      { key: STEPS.CONFIRM, label: "Confirm" },
      { key: STEPS.RESULTS, label: "Results" },
    ]

    const currentIndex = steps.findIndex(
      (s) =>
        s.key === currentStep ||
        (currentStep === STEPS.VALIDATING && s.key === STEPS.UPLOAD) ||
        (currentStep === STEPS.EXECUTING && s.key === STEPS.CONFIRM),
    )

    return (
      <div className="flex items-center justify-center gap-2 mb-6">
        {steps.map((step, index) => (
          <div key={step.key} className="flex items-center">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                index < currentIndex
                  ? "bg-green-500 text-white"
                  : index === currentIndex
                    ? "bg-teal-500 text-white"
                    : "bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400"
              }`}
            >
              {index < currentIndex ? "✓" : index + 1}
            </div>
            {index < steps.length - 1 && (
              <div
                className={`w-12 h-1 mx-1 ${
                  index < currentIndex ? "bg-green-500" : "bg-gray-200 dark:bg-gray-700"
                }`}
              />
            )}
          </div>
        ))}
      </div>
    )
  }

  // =====================
  // STEP: UPLOAD
  // =====================
  if (currentStep === STEPS.UPLOAD) {
    return (
      <div
        className={`h-full flex flex-col bg-white dark:bg-black ${hideHeader ? "" : "p-4"}`}
        style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
      >
        {!hideHeader && (
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
              Batch Payments
            </h1>
            {onClose && (
              <button
                onClick={onClose}
                className="p-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              >
                <svg
                  className="w-6 h-6"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            )}
          </div>
        )}

        {renderStepIndicator()}

        {/* Hidden file input - placed outside the drop zone to prevent
            click event bubbling back into the drop zone's onClick handler,
            which would create an infinite loop and freeze the browser. */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleFileSelect(e)}
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
          className="hidden"
        />

        {/* Upload Area */}
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onClick={() => fileInputRef.current?.click()}
          className={`flex-1 border-2 border-dashed rounded-xl flex flex-col items-center justify-center cursor-pointer transition-colors ${
            csvContent
              ? "border-green-500 bg-green-50 dark:bg-green-900/20"
              : "border-gray-300 dark:border-gray-600 hover:border-teal-500 dark:hover:border-teal-400"
          }`}
        >
          {csvContent ? (
            <>
              <div className="text-5xl mb-4">✓</div>
              <p className="text-lg font-medium text-gray-900 dark:text-white mb-2">
                {fileName}
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400">Click to replace</p>
            </>
          ) : (
            <>
              <div className="text-5xl mb-4">📄</div>
              <p className="text-lg font-medium text-gray-900 dark:text-white mb-2">
                Drop CSV file here or click to upload
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400 text-center max-w-sm">
                Supports Blink usernames, Lightning Addresses, and LNURLs
              </p>
            </>
          )}
        </div>

        {error && (
          <div className="mt-4 p-3 bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-700 rounded-lg text-red-700 dark:text-red-300 text-sm">
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="mt-4 flex gap-3">
          <button
            onClick={handleDownloadTemplate}
            className="flex-1 px-4 py-3 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            Download Template
          </button>
          <button
            onClick={handleValidate}
            disabled={!csvContent}
            className="flex-1 px-4 py-3 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Validate Recipients
          </button>
        </div>
      </div>
    )
  }

  // =====================
  // STEP: VALIDATING
  // =====================
  if (currentStep === STEPS.VALIDATING) {
    const estimatedRecipients = Math.max(1, csvContent.split("\n").length - 1)

    return (
      <div
        className="h-full flex flex-col bg-white dark:bg-black p-4 items-center justify-center"
        style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
      >
        <div className="w-full max-w-sm">
          {/* Animated Lightning Icon */}
          <div className="relative w-24 h-24 mx-auto mb-6">
            <div className="absolute inset-0 bg-teal-500/20 rounded-full animate-ping"></div>
            <div className="absolute inset-2 bg-teal-500/30 rounded-full animate-pulse"></div>
            <div className="absolute inset-0 flex items-center justify-center">
              <svg
                className="w-12 h-12 text-teal-500"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
            </div>
          </div>

          <h2 className="text-xl font-bold text-gray-900 dark:text-white text-center mb-2">
            Validating Recipients
          </h2>
          <p className="text-gray-500 dark:text-gray-400 text-center mb-6">
            Checking {estimatedRecipients} recipients...
          </p>

          {/* Progress bar */}
          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-3 mb-3 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-teal-500 to-teal-400 rounded-full transition-all duration-300 ease-out relative"
              style={{ width: `${Math.round(simulatedProgress)}%` }}
            >
              <div className="absolute inset-0 bg-white/20 animate-pulse"></div>
            </div>
          </div>

          <p className="text-sm text-gray-500 dark:text-gray-400 text-center">
            {Math.round(simulatedProgress)}% complete
          </p>

          {/* Animated dots */}
          <div className="flex justify-center gap-1 mt-4">
            <span
              className="w-2 h-2 bg-teal-500 rounded-full animate-bounce"
              style={{ animationDelay: "0ms" }}
            ></span>
            <span
              className="w-2 h-2 bg-teal-500 rounded-full animate-bounce"
              style={{ animationDelay: "150ms" }}
            ></span>
            <span
              className="w-2 h-2 bg-teal-500 rounded-full animate-bounce"
              style={{ animationDelay: "300ms" }}
            ></span>
          </div>
        </div>
      </div>
    )
  }

  // =====================
  // STEP: REVIEW
  // =====================
  if (currentStep === STEPS.REVIEW && validationResults) {
    const { summary, results, parseErrors: _parseErrors } = validationResults
    const validResults = results.filter((r) => r.valid)
    const invalidResults = results.filter((r) => !r.valid)

    return (
      <div
        className="h-full flex flex-col bg-white dark:bg-black"
        style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
      >
        {/* Header */}
        <div className="p-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
              Validation Results
            </h1>
            {onClose && (
              <button onClick={onClose} className="p-2 text-gray-500 hover:text-gray-700">
                <svg
                  className="w-6 h-6"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            )}
          </div>
          {renderStepIndicator()}
        </div>

        {/* Summary Cards */}
        <div className="p-4 grid grid-cols-3 gap-3">
          <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-3 text-center">
            <div className="text-2xl font-bold text-green-600 dark:text-green-400">
              {summary.valid}
            </div>
            <div className="text-sm text-green-700 dark:text-green-300">Valid</div>
          </div>
          <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-3 text-center">
            <div className="text-2xl font-bold text-red-600 dark:text-red-400">
              {summary.invalid}
            </div>
            <div className="text-sm text-red-700 dark:text-red-300">Invalid</div>
          </div>
          <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 text-center">
            <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">
              {summary.total}
            </div>
            <div className="text-sm text-blue-700 dark:text-blue-300">Total</div>
          </div>
        </div>

        {/* Type breakdown */}
        <div className="px-4 pb-2">
          <div className="flex gap-4 text-sm text-gray-600 dark:text-gray-400">
            <span>Blink: {summary.byType.BLINK || 0}</span>
            <span>Lightning: {summary.byType.LN_ADDRESS || 0}</span>
            <span>LNURL: {summary.byType.LNURL || 0}</span>
          </div>
        </div>

        {/* Recipients List */}
        <div className="flex-1 overflow-y-auto px-4">
          {/* Invalid recipients first */}
          {invalidResults.length > 0 && (
            <div className="mb-4">
              <h3 className="text-sm font-semibold text-red-600 dark:text-red-400 mb-2">
                Invalid Recipients ({invalidResults.length})
              </h3>
              <div className="space-y-2">
                {invalidResults.map((r, i) => (
                  <div
                    key={i}
                    className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-sm text-gray-900 dark:text-white break-all flex-1 min-w-0">
                        {r.normalized || r.recipient}
                      </span>
                      <span className="text-sm text-gray-500 dark:text-gray-400 flex-shrink-0">
                        {r.amount} {r.currency}
                      </span>
                    </div>
                    <p className="text-sm text-red-600 dark:text-red-400 mt-1">
                      {r.error?.message || "Validation failed"}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Valid recipients */}
          {validResults.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-green-600 dark:text-green-400 mb-2">
                Valid Recipients ({validResults.length})
              </h3>
              <div className="space-y-2">
                {validResults.slice(0, 20).map((r, i) => (
                  <div
                    key={i}
                    className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <span
                          className={`px-2 py-0.5 text-xs rounded flex-shrink-0 ${
                            r.type === "BLINK"
                              ? "bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300"
                              : "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300"
                          }`}
                        >
                          {r.type === "BLINK" ? "Blink" : "LN"}
                        </span>
                        <span className="font-mono text-sm text-gray-900 dark:text-white break-all">
                          {r.normalized || r.recipient}
                        </span>
                      </div>
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300 flex-shrink-0">
                        {(r.amountSats || 0).toLocaleString()} sats
                      </span>
                    </div>
                    {r.memo && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate">
                        {r.memo}
                      </p>
                    )}
                  </div>
                ))}
                {validResults.length > 20 && (
                  <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-2">
                    ... and {validResults.length - 20} more
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="p-4 border-t border-gray-200 dark:border-gray-700">
          {error && (
            <div className="mb-3 p-3 bg-red-100 dark:bg-red-900/30 rounded-lg text-red-700 dark:text-red-300 text-sm">
              {error}
            </div>
          )}
          <div className="flex gap-3">
            <button
              onClick={handleReset}
              className="flex-1 px-4 py-3 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              Back
            </button>
            <button
              onClick={() => setCurrentStep(STEPS.CONFIRM)}
              disabled={summary.valid === 0}
              className="flex-1 px-4 py-3 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Continue with {summary.valid} recipients
            </button>
          </div>
        </div>
      </div>
    )
  }

  // =====================
  // STEP: CONFIRM
  // =====================
  if (currentStep === STEPS.CONFIRM && feeSummary) {
    const insufficientBalance =
      balanceSats !== null &&
      balanceSats !== undefined &&
      balanceSats < feeSummary.grandTotalSats

    return (
      <div
        className="h-full flex flex-col bg-white dark:bg-black"
        style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
      >
        {/* Header */}
        <div className="p-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
              Confirm Payment
            </h1>
            {onClose && (
              <button onClick={onClose} className="p-2 text-gray-500 hover:text-gray-700">
                <svg
                  className="w-6 h-6"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            )}
          </div>
          {renderStepIndicator()}
        </div>

        {/* Payment Summary */}
        <div className="flex-1 p-4">
          <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
              Payment Summary
            </h3>

            <div className="space-y-3">
              {/* Intra-ledger */}
              <div className="flex justify-between text-sm">
                <span className="text-gray-600 dark:text-gray-400">
                  Blink Users ({feeSummary.breakdown.intraLedger.count})
                </span>
                <span className="text-gray-900 dark:text-white">0 sats fee</span>
              </div>

              {/* External */}
              <div className="flex justify-between text-sm">
                <span className="text-gray-600 dark:text-gray-400">
                  External ({feeSummary.breakdown.external.count})
                </span>
                <span className="text-gray-900 dark:text-white">
                  ~{feeSummary.breakdown.external.feesSats.toLocaleString()} sats fee
                </span>
              </div>

              <hr className="border-gray-200 dark:border-gray-700" />

              {/* Total Amount */}
              <div className="flex justify-between">
                <span className="text-gray-600 dark:text-gray-400">Total Amount</span>
                <span className="font-medium text-gray-900 dark:text-white">
                  {feeSummary.totalAmountSats.toLocaleString()} sats
                </span>
              </div>

              {/* Network Fees */}
              <div className="flex justify-between">
                <span className="text-gray-600 dark:text-gray-400">
                  Network Fees (est.)
                </span>
                <span className="font-medium text-gray-900 dark:text-white">
                  {feeSummary.totalFeesSats.toLocaleString()} sats
                </span>
              </div>

              <hr className="border-gray-200 dark:border-gray-700" />

              {/* Grand Total */}
              <div className="flex justify-between text-lg">
                <span className="font-semibold text-gray-900 dark:text-white">
                  Total Cost
                </span>
                <span className="font-bold text-teal-600 dark:text-teal-400">
                  {feeSummary.grandTotalSats.toLocaleString()} sats
                </span>
              </div>

              {/* Balance */}
              {balanceSats !== null && balanceSats !== undefined && (
                <>
                  <hr className="border-gray-200 dark:border-gray-700" />
                  <div className="flex justify-between">
                    <span className="text-gray-600 dark:text-gray-400">Your Balance</span>
                    <span
                      className={`font-medium ${insufficientBalance ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}
                    >
                      {balanceSats.toLocaleString()} sats
                    </span>
                  </div>
                  {!insufficientBalance && (
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-500 dark:text-gray-500">
                        After Payment
                      </span>
                      <span className="text-gray-600 dark:text-gray-400">
                        {(balanceSats - feeSummary.grandTotalSats).toLocaleString()} sats
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Warning for insufficient balance */}
            {insufficientBalance && balanceSats !== null && (
              <div className="mt-4 p-3 bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-700 rounded-lg">
                <p className="text-sm text-red-700 dark:text-red-300">
                  Insufficient balance. You need{" "}
                  {(feeSummary.grandTotalSats - balanceSats).toLocaleString()} more sats.
                </p>
              </div>
            )}

            {/* Fee estimate note */}
            <p className="mt-4 text-xs text-gray-500 dark:text-gray-400 text-center">
              Fees are estimated. Actual fees may vary based on Lightning network
              conditions.
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="p-4 border-t border-gray-200 dark:border-gray-700">
          {error && (
            <div className="mb-3 p-3 bg-red-100 dark:bg-red-900/30 rounded-lg text-red-700 dark:text-red-300 text-sm">
              {error}
            </div>
          )}
          <div className="flex gap-3">
            <button
              onClick={() => setCurrentStep(STEPS.REVIEW)}
              className="flex-1 px-4 py-3 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              Back
            </button>
            <button
              onClick={handleExecute}
              disabled={insufficientBalance}
              className="flex-1 px-4 py-3 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
            >
              Send {feeSummary.grandTotalSats.toLocaleString()} sats
            </button>
          </div>
        </div>
      </div>
    )
  }

  // =====================
  // STEP: EXECUTING
  // =====================
  if (currentStep === STEPS.EXECUTING) {
    const displayProgress = Math.round(simulatedProgress)
    const circumference = 2 * Math.PI * 56

    return (
      <div
        className="h-full flex flex-col bg-white dark:bg-black p-4 items-center justify-center"
        style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
      >
        <div className="w-full max-w-sm">
          {/* Animated Progress Circle */}
          <div className="relative w-36 h-36 mx-auto mb-6">
            {/* Glow effect */}
            <div
              className="absolute inset-0 rounded-full blur-xl transition-opacity duration-300"
              style={{
                background: `conic-gradient(from 0deg, transparent, rgba(20, 184, 166, ${0.3 * (displayProgress / 100)}), transparent)`,
              }}
            ></div>

            <svg className="w-full h-full transform -rotate-90" viewBox="0 0 128 128">
              {/* Background circle */}
              <circle
                cx="64"
                cy="64"
                r="56"
                stroke="currentColor"
                strokeWidth="8"
                fill="none"
                className="text-gray-200 dark:text-gray-700"
              />
              {/* Progress circle with gradient */}
              <circle
                cx="64"
                cy="64"
                r="56"
                stroke="url(#progressGradient)"
                strokeWidth="8"
                fill="none"
                strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - displayProgress / 100)}
                className="transition-all duration-300 ease-out"
                strokeLinecap="round"
              />
              {/* Gradient definition */}
              <defs>
                <linearGradient id="progressGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#14b8a6" />
                  <stop offset="50%" stopColor="#2dd4bf" />
                  <stop offset="100%" stopColor="#5eead4" />
                </linearGradient>
              </defs>
            </svg>

            {/* Center content */}
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-3xl font-bold text-gray-900 dark:text-white">
                {displayProgress}%
              </span>
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {progress.total} payments
              </span>
            </div>
          </div>

          <h2 className="text-xl font-bold text-gray-900 dark:text-white text-center mb-2">
            Sending Payments
          </h2>

          {/* Animated status messages */}
          <div className="text-center mb-4">
            <p className="text-gray-500 dark:text-gray-400 animate-pulse">
              {displayProgress < 30 && "Initiating payments..."}
              {displayProgress >= 30 &&
                displayProgress < 60 &&
                "Processing transactions..."}
              {displayProgress >= 60 && displayProgress < 85 && "Almost there..."}
              {displayProgress >= 85 && "Finalizing..."}
            </p>
          </div>

          {/* Progress bar */}
          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 mb-4 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-teal-500 via-teal-400 to-teal-300 rounded-full transition-all duration-300 ease-out"
              style={{ width: `${displayProgress}%` }}
            ></div>
          </div>

          {/* Animated dots */}
          <div className="flex justify-center gap-2 mt-4">
            <span
              className="w-2 h-2 bg-teal-500 rounded-full animate-bounce"
              style={{ animationDelay: "0ms" }}
            ></span>
            <span
              className="w-2 h-2 bg-teal-400 rounded-full animate-bounce"
              style={{ animationDelay: "150ms" }}
            ></span>
            <span
              className="w-2 h-2 bg-teal-300 rounded-full animate-bounce"
              style={{ animationDelay: "300ms" }}
            ></span>
          </div>

          <p className="text-xs text-gray-400 dark:text-gray-500 text-center mt-6">
            Please wait, do not close this window
          </p>
        </div>
      </div>
    )
  }

  // =====================
  // STEP: RESULTS
  // =====================
  if (currentStep === STEPS.RESULTS && executionResults) {
    const { summary, results } = executionResults
    const _successfulResults = results.filter((r) => r.success)
    const failedResults = results.filter((r) => !r.success)

    return (
      <div
        className="h-full flex flex-col bg-white dark:bg-black"
        style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
      >
        {/* Header */}
        <div className="p-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
              Batch Complete
            </h1>
            {onClose && (
              <button onClick={onClose} className="p-2 text-gray-500 hover:text-gray-700">
                <svg
                  className="w-6 h-6"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            )}
          </div>
          {renderStepIndicator()}
        </div>

        {/* Success Summary */}
        <div className="p-4">
          <div
            className={`rounded-xl p-6 text-center ${
              summary.failed === 0
                ? "bg-green-50 dark:bg-green-900/20"
                : "bg-yellow-50 dark:bg-yellow-900/20"
            }`}
          >
            <div className="text-5xl mb-3">{summary.failed === 0 ? "🎉" : "⚠️"}</div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
              {summary.failed === 0
                ? "All Payments Successful!"
                : `${summary.successful} of ${summary.totalRecipients} Successful`}
            </h2>
            <p className="text-gray-600 dark:text-gray-400">
              Total sent: {summary.totalSentSats.toLocaleString()} sats
            </p>
          </div>
        </div>

        {/* Results Summary */}
        <div className="px-4 grid grid-cols-2 gap-3">
          <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-3 text-center">
            <div className="text-2xl font-bold text-green-600 dark:text-green-400">
              {summary.successful}
            </div>
            <div className="text-sm text-green-700 dark:text-green-300">Successful</div>
          </div>
          <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-3 text-center">
            <div className="text-2xl font-bold text-red-600 dark:text-red-400">
              {summary.failed}
            </div>
            <div className="text-sm text-red-700 dark:text-red-300">Failed</div>
          </div>
        </div>

        {/* Failed Payments List */}
        {failedResults.length > 0 && (
          <div className="flex-1 overflow-y-auto p-4">
            <h3 className="text-sm font-semibold text-red-600 dark:text-red-400 mb-2">
              Failed Payments ({failedResults.length})
            </h3>
            <div className="space-y-2">
              {failedResults.map((r, i) => (
                <div
                  key={i}
                  className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-sm text-gray-900 dark:text-white break-all flex-1 min-w-0">
                      {r.normalized || r.recipient}
                    </span>
                    <span className="text-sm text-gray-500 dark:text-gray-400 flex-shrink-0">
                      {(r.amountSats || 0).toLocaleString()} sats
                    </span>
                  </div>
                  <p className="text-sm text-red-600 dark:text-red-400 mt-1">
                    {r.error?.message || "Payment failed"}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="p-4 border-t border-gray-200 dark:border-gray-700">
          <div className="flex gap-3">
            <button
              onClick={handleDownloadResults}
              className="flex-1 px-4 py-3 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              Download Report
            </button>
            <button
              onClick={handleReset}
              className="flex-1 px-4 py-3 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors"
            >
              New Batch
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Fallback
  return null
}
