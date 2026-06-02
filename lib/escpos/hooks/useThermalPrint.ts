/**
 * useThermalPrint - React hook for thermal printing vouchers
 *
 * Provides a simple interface to the ESC/POS printing system for React components.
 * Handles platform detection, adapter selection, and print job management.
 *
 * Usage:
 * ```jsx
 * import { useThermalPrint } from '@/lib/escpos/hooks/useThermalPrint';
 *
 * function VoucherComponent({ voucher }) {
 *   const {
 *     print,
 *     printMethods,
 *     selectedMethod,
 *     setSelectedMethod,
 *     isPrinting,
 *     error
 *   } = useThermalPrint();
 *
 *   return (
 *     <button onClick={() => print(voucher)} disabled={isPrinting}>
 *       {isPrinting ? 'Printing...' : 'Print'}
 *     </button>
 *   );
 * }
 * ```
 */

import { useState, useEffect, useCallback, useRef } from "react"

import ConnectionManager, { getConnectionManager } from "../ConnectionManager"
import PrintService, { getPrintService, PrintStatus, ReceiptType } from "../PrintService"

interface PrintMethod {
  type: string
  name: string
  available: boolean
  recommended: boolean
}

interface PrintHookResult {
  success: boolean
  error?: string
  jobId?: string
  adapter?: string
}

interface Recommendations {
  platform: Record<string, unknown>
  primaryMethod: string | null
  fallbackMethod: string | null
  availableMethods: Array<{ type: string; name: string; recommended: boolean }>
  tips: string[]
}

interface UseThermalPrintOptions {
  [key: string]: unknown
}

interface UseThermalPrintReturn {
  printMethods: PrintMethod[]
  selectedMethod: string | null
  isPrinting: boolean
  printStatus: string | null
  error: string | null
  lastResult: PrintHookResult | null
  recommendations: Recommendations | null
  isLoading: boolean
  print: (
    voucher: Record<string, unknown>,
    printOptions?: Record<string, unknown>,
  ) => Promise<PrintHookResult>
  printReceipt: (
    receipt: Record<string, unknown>,
    printOptions?: Record<string, unknown>,
  ) => Promise<PrintHookResult>
  printStandard: (
    voucher: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => Promise<PrintHookResult>
  printMinimal: (
    voucher: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => Promise<PrintHookResult>
  printReissue: (
    voucher: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => Promise<PrintHookResult>
  selectMethod: (methodType: string) => Promise<void>
  setSelectedMethod: (methodType: string) => Promise<void>
  getDeepLinkUrl: (
    voucher: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => Promise<string | null>
  clearError: () => void
  isMethodAvailable: (methodType: string) => boolean
  isMobile: () => boolean
  printService: PrintService | null
  connectionManager: ConnectionManager | null
}

/**
 * useThermalPrint hook
 * @param {object} options - Hook options
 * @returns {object} Hook state and methods
 */
export function useThermalPrint(
  options: UseThermalPrintOptions = {},
): UseThermalPrintReturn {
  // State
  const [printMethods, setPrintMethods] = useState<PrintMethod[]>([])
  const [selectedMethod, setSelectedMethod] = useState<string | null>(null)
  const [isPrinting, setIsPrinting] = useState<boolean>(false)
  const [printStatus, setPrintStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<PrintHookResult | null>(null)
  const [recommendations, setRecommendations] = useState<Recommendations | null>(null)
  const [isLoading, setIsLoading] = useState<boolean>(true)

  // Refs
  const printServiceRef = useRef<PrintService | null>(null)
  const connectionManagerRef = useRef<ConnectionManager | null>(null)

  // Initialize services
  useEffect(() => {
    printServiceRef.current = getPrintService(options)
    connectionManagerRef.current = getConnectionManager()

    // Load available methods
    const loadMethods = async (): Promise<void> => {
      setIsLoading(true)
      try {
        const methods: PrintMethod[] =
          await printServiceRef.current!.getAvailableMethods()
        const recs = await printServiceRef.current!.getRecommendations()

        setPrintMethods(methods)
        setRecommendations(recs as unknown as Recommendations)

        // Select recommended method
        const recommended: PrintMethod | undefined = methods.find(
          (m: PrintMethod) => m.recommended && m.available,
        )
        if (recommended) {
          setSelectedMethod(recommended.type)
        } else {
          // Fall back to first available
          const firstAvailable: PrintMethod | undefined = methods.find(
            (m: PrintMethod) => m.available,
          )
          if (firstAvailable) {
            setSelectedMethod(firstAvailable.type)
          }
        }
      } catch (err: unknown) {
        console.error("Error loading print methods:", err)
        setError("Failed to initialize print system")
      } finally {
        setIsLoading(false)
      }
    }

    loadMethods()

    // Subscribe to print events
    const unsubscribeStatus: () => void = printServiceRef.current.on(
      "jobStatus",
      ({ status, error: jobError }: Record<string, unknown>) => {
        setPrintStatus(status as string)
        if (status === PrintStatus.FAILED && jobError) {
          setError(jobError as string)
        }
      },
    )

    const unsubscribeComplete: () => void = printServiceRef.current.on(
      "jobCompleted",
      (data: Record<string, unknown>) => {
        setIsPrinting(false)
        setLastResult({ success: true, ...data } as PrintHookResult)
      },
    )

    const unsubscribeFailed: () => void = printServiceRef.current.on(
      "jobFailed",
      ({ error: jobError }: Record<string, unknown>) => {
        setIsPrinting(false)
        setError(jobError as string)
        setLastResult({ success: false, error: jobError as string })
      },
    )

    return () => {
      unsubscribeStatus()
      unsubscribeComplete()
      unsubscribeFailed()
    }
  }, [])

  /**
   * Print a voucher
   * @param {object} voucher - Voucher data
   * @param {object} printOptions - Print options
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  const print = useCallback(
    async (
      voucher: Record<string, unknown>,
      printOptions: Record<string, unknown> = {},
    ): Promise<PrintHookResult> => {
      if (!printServiceRef.current) {
        return { success: false, error: "Print service not initialized" }
      }

      setIsPrinting(true)
      setError(null)
      setPrintStatus(PrintStatus.PENDING)

      try {
        let result: PrintHookResult

        if (selectedMethod && selectedMethod !== "auto") {
          result = await printServiceRef.current.printWithAdapter(
            voucher as never,
            selectedMethod,
            printOptions,
          )
        } else {
          result = await printServiceRef.current.printVoucher(
            voucher as never,
            printOptions,
          )
        }

        setLastResult(result)

        if (!result.success) {
          setError(result.error || null)
        }

        return result
      } catch (err: unknown) {
        const errorMsg: string = (err as Error).message || "Print failed"
        setError(errorMsg)
        setLastResult({ success: false, error: errorMsg })
        return { success: false, error: errorMsg }
      } finally {
        setIsPrinting(false)
      }
    },
    [selectedMethod],
  )

  /**
   * Print with a specific receipt type
   */
  const printStandard = useCallback(
    (
      voucher: Record<string, unknown>,
      opts: Record<string, unknown> = {},
    ): Promise<PrintHookResult> => {
      return print(voucher, { ...opts, receiptType: ReceiptType.STANDARD })
    },
    [print],
  )

  const printMinimal = useCallback(
    (
      voucher: Record<string, unknown>,
      opts: Record<string, unknown> = {},
    ): Promise<PrintHookResult> => {
      return print(voucher, { ...opts, receiptType: ReceiptType.MINIMAL })
    },
    [print],
  )

  const printReissue = useCallback(
    (
      voucher: Record<string, unknown>,
      opts: Record<string, unknown> = {},
    ): Promise<PrintHookResult> => {
      return print(voucher, { ...opts, receiptType: ReceiptType.REISSUE })
    },
    [print],
  )

  /**
   * Print a payment receipt.
   *
   * Uses the currently active adapter (which tracks the selected method via
   * selectMethod). Receipts route through PrintService.printReceipt → the
   * CompanionAdapter `app=payment` deep link on mobile, or raw ESC/POS on
   * local-print-server / WebSerial on desktop.
   *
   * @param receipt - Pre-formatted receipt data (amount string already combined)
   * @param printOptions - Print options
   */
  const printReceipt = useCallback(
    async (
      receipt: Record<string, unknown>,
      printOptions: Record<string, unknown> = {},
    ): Promise<PrintHookResult> => {
      if (!printServiceRef.current) {
        return { success: false, error: "Print service not initialized" }
      }

      setIsPrinting(true)
      setError(null)
      setPrintStatus(PrintStatus.PENDING)

      try {
        const result = await printServiceRef.current.printReceipt(
          receipt as never,
          printOptions,
        )
        setLastResult(result)
        if (!result.success) {
          setError(result.error || null)
        }
        return result
      } catch (err: unknown) {
        const errorMsg: string = (err as Error).message || "Print failed"
        setError(errorMsg)
        setLastResult({ success: false, error: errorMsg })
        return { success: false, error: errorMsg }
      } finally {
        setIsPrinting(false)
      }
    },
    [],
  )

  /**
   * Change print method
   */
  const selectMethod = useCallback(async (methodType: string): Promise<void> => {
    setSelectedMethod(methodType)

    if (connectionManagerRef.current) {
      try {
        await connectionManagerRef.current.setActiveAdapter(methodType)
      } catch (err: unknown) {
        console.warn("Could not set adapter:", err)
      }
    }
  }, [])

  /**
   * Get deep link URL for companion app
   */
  const getDeepLinkUrl = useCallback(
    async (
      voucher: Record<string, unknown>,
      opts: Record<string, unknown> = {},
    ): Promise<string | null> => {
      if (!printServiceRef.current) return null
      try {
        return await printServiceRef.current.getDeepLinkUrl(voucher as never, opts)
      } catch (_err: unknown) {
        return null
      }
    },
    [],
  )

  /**
   * Clear error state
   */
  const clearError = useCallback((): void => {
    setError(null)
  }, [])

  /**
   * Check if a method is available
   */
  const isMethodAvailable = useCallback(
    (methodType: string): boolean => {
      const method: PrintMethod | undefined = printMethods.find(
        (m: PrintMethod) => m.type === methodType,
      )
      return method?.available || false
    },
    [printMethods],
  )

  /**
   * Check if on mobile
   */
  const isMobile = useCallback((): boolean => {
    return connectionManagerRef.current?.isMobile() || false
  }, [])

  return {
    // State
    printMethods,
    selectedMethod,
    isPrinting,
    printStatus,
    error,
    lastResult,
    recommendations,
    isLoading,

    // Methods
    print,
    printReceipt,
    printStandard,
    printMinimal,
    printReissue,
    selectMethod,
    setSelectedMethod: selectMethod,
    getDeepLinkUrl,
    clearError,
    isMethodAvailable,
    isMobile,

    // Service access (for advanced use)
    printService: printServiceRef.current,
    connectionManager: connectionManagerRef.current,
  }
}

export default useThermalPrint
