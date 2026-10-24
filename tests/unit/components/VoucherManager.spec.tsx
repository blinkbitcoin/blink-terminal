/**
 * VoucherManager: voucher-wallet key propagation to the owner-scoped
 * list/cancel API, the no-key path, and stale-response handling when the key
 * changes.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import { ExpiryBadge } from "../../../components/ExpirySelector"
import VoucherManager from "../../../components/VoucherManager"

jest.mock("react-qr-code", () => ({
  __esModule: true,
  default: () => <div data-testid="qr" />,
}))
jest.mock("../../../lib/config/api", () => ({
  getEnvironment: () => "production",
}))

type Wallet = { apiKey?: string; walletId?: string; username?: string }

const listed = (id: string) => ({
  id,
  shortId: id.substring(0, 8).toUpperCase(),
  amount: 500,
  claimed: false,
  createdAt: Date.now(),
  expiresAt: Date.now() + 3600_000,
  status: "ACTIVE",
  walletCurrency: "BTC",
  commissionPercent: 0,
  timeRemaining: 3600_000,
})

const ok = (body: unknown) =>
  Promise.resolve({ json: () => Promise.resolve(body) } as Response)

const listBody = (ids: string[]) => ({
  success: true,
  vouchers: ids.map(listed),
  stats: {
    total: ids.length,
    active: ids.length,
    claimed: 0,
    cancelled: 0,
    expired: 0,
    expiringSoon: 0,
  },
})

const props = (voucherWallet: Wallet | null) => ({
  voucherWallet: voucherWallet as never,
  displayCurrency: "BTC",
  currencies: [],
  darkMode: false,
  theme: "light",
  cycleTheme: jest.fn(),
  soundEnabled: false,
})

const fetchMock = jest.fn()

beforeEach(() => {
  fetchMock.mockReset()
  global.fetch = fetchMock as unknown as typeof fetch
})

describe("VoucherManager", () => {
  it("lists with the voucher wallet key header and the environment", async () => {
    fetchMock.mockImplementation(() => ok(listBody(["a".repeat(32)])))

    render(<VoucherManager {...props({ apiKey: "blink_owner" })} />)

    await screen.findByText("AAAAAAAA")
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/voucher/list?environment=production&limit=100")
    expect(init.headers).toEqual({ "x-voucher-api-key": "blink_owner" })
  })

  it("loads older pages on demand (blink-wip#1617)", async () => {
    const cursor = `1000_${"9".repeat(64)}` // created_at + sha256(id): no voucher id
    fetchMock.mockImplementation((url: string) =>
      url.includes("before=")
        ? ok({ ...listBody(["b".repeat(32)]), nextCursor: null })
        : ok({ ...listBody(["a".repeat(32)]), nextCursor: cursor }),
    )

    render(<VoucherManager {...props({ apiKey: "blink_owner" })} />)
    await screen.findByText("AAAAAAAA")
    expect(screen.queryByText("BBBBBBBB")).toBeNull()

    fireEvent.click(await screen.findByText("Load older vouchers"))
    await screen.findByText("BBBBBBBB")
    expect(screen.getByText("AAAAAAAA")).toBeTruthy()

    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe(
      `/api/voucher/list?environment=production&limit=100&before=${encodeURIComponent(cursor)}`,
    )
    expect(init.headers).toEqual({ "x-voucher-api-key": "blink_owner" })
    // Last page: no more button.
    expect(screen.queryByText("Load older vouchers")).toBeNull()
  })

  it("cancelling a voucher from an older page shows it cancelled (first-page refresh does not cover it)", async () => {
    const cursor = `1000_${"9".repeat(64)}`
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/api/voucher/cancel")) return ok({ success: true })
      if (url.includes("before="))
        return ok({ ...listBody(["b".repeat(32)]), nextCursor: null })
      // The first page never contains the older voucher.
      return ok({ ...listBody(["a".repeat(32)]), nextCursor: cursor })
    })

    render(<VoucherManager {...props({ apiKey: "blink_owner" })} />)
    fireEvent.click(await screen.findByText("Load older vouchers"))
    fireEvent.click(await screen.findByText("BBBBBBBB"))
    fireEvent.click(await screen.findByText("Cancel Voucher"))

    // Back on the list, after the first-page refresh, B is cancelled...
    await waitFor(() => expect(screen.queryByText("Cancel Voucher")).toBeNull())
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([u]) => !String(u).includes("cancel")),
      ).toHaveLength(3),
    )
    expect(await screen.findByText("CANCELLED")).toBeTruthy()

    // ...and its detail offers no active-only actions.
    fireEvent.click(screen.getByText("BBBBBBBB"))
    await screen.findAllByText("CANCELLED")
    expect(screen.queryByText("Cancel Voucher")).toBeNull()
  })

  it("an older page that arrives after a key switch is dropped", async () => {
    let resolveMore: (value: Response) => void = () => {}
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      const key = (init.headers as Record<string, string>)["x-voucher-api-key"]
      if (url.includes("before=")) {
        return new Promise<Response>((resolve) => {
          resolveMore = resolve
        })
      }
      return key === "blink_old"
        ? ok({ ...listBody(["a".repeat(32)]), nextCursor: `1000_${"9".repeat(64)}` })
        : ok(listBody(["c".repeat(32)]))
    })

    const { rerender } = render(<VoucherManager {...props({ apiKey: "blink_old" })} />)
    fireEvent.click(await screen.findByText("Load older vouchers"))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    rerender(<VoucherManager {...props({ apiKey: "blink_new" })} />)
    await screen.findByText("CCCCCCCC")

    await act(async () => {
      resolveMore({
        json: () => Promise.resolve({ ...listBody(["b".repeat(32)]), nextCursor: null }),
      } as Response)
    })
    expect(screen.queryByText("BBBBBBBB")).toBeNull()
    expect(screen.queryByText("AAAAAAAA")).toBeNull()
  })

  it("makes no request and shows an empty list without a key", async () => {
    render(<VoucherManager {...props(null)} />)

    await screen.findByText("No vouchers yet")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("sends the key when cancelling", async () => {
    fetchMock.mockImplementation((url: string) =>
      url.startsWith("/api/voucher/cancel")
        ? ok({ success: true })
        : ok(listBody(["b".repeat(32)])),
    )

    render(<VoucherManager {...props({ apiKey: "blink_owner" })} />)
    fireEvent.click(await screen.findByText("BBBBBBBB"))
    fireEvent.click(await screen.findByText("Cancel Voucher"))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/voucher/cancel",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ "x-voucher-api-key": "blink_owner" }),
          body: JSON.stringify({ chargeId: "b".repeat(32) }),
        }),
      ),
    )
  })

  it("drops a late response for the previous key and aborts it", async () => {
    let resolveOld: (value: Response) => void = () => {}
    const signals: AbortSignal[] = []
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal)
      const key = (init.headers as Record<string, string>)["x-voucher-api-key"]
      if (key === "blink_old") {
        return new Promise<Response>((resolve) => {
          resolveOld = resolve
        })
      }
      return ok(listBody(["c".repeat(32)]))
    })

    const { rerender } = render(<VoucherManager {...props({ apiKey: "blink_old" })} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    rerender(<VoucherManager {...props({ apiKey: "blink_new" })} />)
    await screen.findByText("CCCCCCCC")
    expect(signals[0].aborted).toBe(true)

    // The old key's response arrives late: it must not replace the new list.
    await act(async () => {
      resolveOld({
        json: () => Promise.resolve(listBody(["d".repeat(32)])),
      } as Response)
    })
    expect(screen.queryByText("DDDDDDDD")).toBeNull()
    expect(screen.getByText("CCCCCCCC")).toBeTruthy()
  })

  it("a cancel that completes after a key switch never restores the old key's vouchers", async () => {
    let releaseCancel: (value: Response) => void = () => {}
    let cancelSignal: AbortSignal | undefined
    const listKeys: string[] = []
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      const key = (init.headers as Record<string, string>)["x-voucher-api-key"]
      if (url.startsWith("/api/voucher/cancel")) {
        cancelSignal = init.signal as AbortSignal
        // Held back; resolves only when the test releases it (ignores abort,
        // like a response that was already in flight).
        return new Promise<Response>((resolve) => {
          releaseCancel = resolve
        })
      }
      listKeys.push(key)
      return ok(listBody([key === "blink_a" ? "a1".repeat(16) : "b1".repeat(16)]))
    })

    const { rerender } = render(<VoucherManager {...props({ apiKey: "blink_a" })} />)
    fireEvent.click(await screen.findByText("A1A1A1A1"))
    fireEvent.click(await screen.findByText("Cancel Voucher"))
    await waitFor(() => expect(cancelSignal).toBeDefined())

    rerender(<VoucherManager {...props({ apiKey: "blink_b" })} />)
    await screen.findByText("B1B1B1B1")
    expect(cancelSignal?.aborted).toBe(true)

    // Key A's cancel response arrives late.
    await act(async () => {
      releaseCancel({ json: () => Promise.resolve({ success: true }) } as Response)
    })

    expect(screen.queryByText("A1A1A1A1")).toBeNull()
    expect(screen.getByText("B1B1B1B1")).toBeTruthy()
    // No list request with key A after the switch.
    expect(listKeys).toEqual(["blink_a", "blink_b"])
  })

  it("clears the list when the key is removed", async () => {
    fetchMock.mockImplementation(() => ok(listBody(["e".repeat(32)])))

    const { rerender } = render(<VoucherManager {...props({ apiKey: "blink_owner" })} />)
    await screen.findByText("EEEEEEEE")

    rerender(<VoucherManager {...props(null)} />)
    await screen.findByText("No vouchers yet")
    expect(screen.queryByText("EEEEEEEE")).toBeNull()
  })

  it("treats settled PAID vouchers as redeemed in the Claimed tab", async () => {
    const claimedAt = Date.now() - 60_000
    fetchMock.mockImplementation(() =>
      ok({
        ...listBody([]),
        vouchers: [
          { ...listed("p".repeat(32)), status: "PAID", claimed: true, claimedAt },
          { ...listed("c".repeat(32)), status: "CLAIMED", claimed: true, claimedAt },
          listed("f".repeat(32)),
        ],
      }),
    )

    render(<VoucherManager {...props({ apiKey: "blink_owner" })} />)
    await screen.findByText("PPPPPPPP")
    fireEvent.click(screen.getByRole("button", { name: "Claimed" }))

    expect(screen.getByText("PPPPPPPP")).toBeTruthy()
    expect(screen.getByText("CCCCCCCC")).toBeTruthy()
    expect(screen.queryByText("FFFFFFFF")).toBeNull()
    expect(screen.getByText("PAID").className).toContain("text-green-600")
  })
})

describe("ExpiryBadge", () => {
  it("labels a settled voucher Paid, never by its (past) expiry", () => {
    render(<ExpiryBadge expiresAt={Date.now() - 1000} status="PAID" />)
    expect(screen.getByText("Paid")).toBeTruthy()
    expect(screen.queryByText("Expired")).toBeNull()
  })
})
