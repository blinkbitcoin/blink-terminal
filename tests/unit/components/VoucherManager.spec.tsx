/**
 * VoucherManager: voucher-wallet key propagation to the owner-scoped
 * list/cancel API, the no-key path, and stale-response handling when the key
 * changes.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

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
    expect(url).toBe("/api/voucher/list?environment=production")
    expect(init.headers).toEqual({ "x-voucher-api-key": "blink_owner" })
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

  it("clears the list when the key is removed", async () => {
    fetchMock.mockImplementation(() => ok(listBody(["e".repeat(32)])))

    const { rerender } = render(<VoucherManager {...props({ apiKey: "blink_owner" })} />)
    await screen.findByText("EEEEEEEE")

    rerender(<VoucherManager {...props(null)} />)
    await screen.findByText("No vouchers yet")
    expect(screen.queryByText("EEEEEEEE")).toBeNull()
  })
})
