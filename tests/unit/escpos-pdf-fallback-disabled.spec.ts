/**
 * With server-side voucher PDF disabled, the "no real printer" fallback
 * (ConnectionManager.getBestAdapter() → PDFAdapter) must fail with a clear
 * message and never call /api/voucher/pdf.
 */

import type { BaseAdapter } from "../../lib/escpos/adapters/BaseAdapter"
import PDFAdapter, {
  PDF_FALLBACK_DISABLED_MESSAGE,
} from "../../lib/escpos/adapters/PDFAdapter"
import { ConnectionManager } from "../../lib/escpos/ConnectionManager"
import { PrintService } from "../../lib/escpos/PrintService"

const unavailable = (type: string) =>
  ({ type, isAvailable: async () => false }) as unknown as BaseAdapter

const noPrinterManager = (): ConnectionManager => {
  const manager = new ConnectionManager()
  manager._adapters = new Map<string, BaseAdapter>([
    ["localprint", unavailable("localprint")],
    ["companion", unavailable("companion")],
    ["webserial", unavailable("webserial")],
    ["pdf", new PDFAdapter()],
  ])
  return manager
}

describe("PDF print fallback while voucher PDF is disabled", () => {
  const rawFetch = jest.fn()

  beforeEach(() => {
    rawFetch.mockReset()
    global.fetch = rawFetch as unknown as typeof fetch
  })

  it("PDFAdapter reports itself unavailable", async () => {
    await expect(new PDFAdapter().isAvailable()).resolves.toBe(false)
  })

  it("PDFAdapter.print throws the clear message without fetching", async () => {
    const adapter = new PDFAdapter()
    await expect(
      adapter.print(new Uint8Array(), {
        voucher: { lnurl: "lnurl1x", satsAmount: 1 } as never,
      }),
    ).rejects.toThrow(PDF_FALLBACK_DISABLED_MESSAGE)
    expect(rawFetch).not.toHaveBeenCalled()
  })

  it("is not listed as an available print method", async () => {
    const adapters = await noPrinterManager().getAvailableAdapters()
    expect(adapters.filter((a) => a.available)).toEqual([])
  })

  it("PrintService.printVoucher with no printer fails clearly and never calls the PDF route", async () => {
    const manager = noPrinterManager()
    // The last-resort fallback is still the PDF adapter...
    await expect(manager.getBestAdapter()).resolves.toBeInstanceOf(PDFAdapter)

    const service = new PrintService({ retryOnFail: false })
    service.connectionManager = manager
    jest.spyOn(service, "_buildReceipt").mockResolvedValue(new Uint8Array([0x1b]))

    // ...but printing through it fails with an actionable message.
    const result = await service.printVoucher({ lnurl: "lnurl1x", satsAmount: 100 })

    expect(result.success).toBe(false)
    expect(result.error).toBe(PDF_FALLBACK_DISABLED_MESSAGE)
    expect(rawFetch).not.toHaveBeenCalled()
  })
})
