/**
 * Smoke + branch tests for PrintPaycodeView.
 *
 * Covers the three render states (validating / error / success), the action
 * buttons, that the QR uses the wrapped qrValue, and the two back-navigation
 * modes (overlay onBack vs standalone router.push).
 */

import { render, screen, fireEvent } from "@testing-library/react"

// --- Mocks -----------------------------------------------------------------

const mockPush = jest.fn()
jest.mock("next/router", () => ({
  useRouter: () => ({ push: mockPush }),
}))

jest.mock("../../../lib/hooks/useTheme", () => ({
  useTheme: () => ({ theme: "dark", cycleTheme: jest.fn(), darkMode: true }),
}))

let mockValidation: {
  validationError: { message: string; suggestion: string } | null
  validating: boolean
  validatedWalletCurrency: string
}
jest.mock("../../../lib/hooks/usePublicPOSValidation", () => ({
  usePublicPOSValidation: () => mockValidation,
}))

// Render QR as a simple element exposing its encoded value for assertions.
jest.mock("qrcode.react", () => ({
  QRCodeSVG: ({ value }: { value: string }) => (
    <div data-testid="qr-svg" data-value={value} />
  ),
  QRCodeCanvas: ({ value }: { value: string }) => (
    <div data-testid="qr-canvas" data-value={value} />
  ),
}))

import PrintPaycodeView from "../../../components/PublicPOS/PrintPaycodeView"

beforeEach(() => {
  mockPush.mockClear()
  mockValidation = {
    validationError: null,
    validating: false,
    validatedWalletCurrency: "BTC",
  }
})

describe("PrintPaycodeView", () => {
  it("shows a loading state while validating", () => {
    mockValidation = {
      validationError: null,
      validating: true,
      validatedWalletCurrency: "BTC",
    }
    render(<PrintPaycodeView username="alice" />)
    expect(screen.getByText(/Checking username/i)).toBeInTheDocument()
    expect(screen.queryByTestId("qr-svg")).not.toBeInTheDocument()
  })

  it("shows the validation error state", () => {
    mockValidation = {
      validationError: {
        message: "User 'nope' does not exist.",
        suggestion: "Check spelling.",
      },
      validating: false,
      validatedWalletCurrency: "BTC",
    }
    render(<PrintPaycodeView username="nope" />)
    expect(screen.getByText("User 'nope' does not exist.")).toBeInTheDocument()
    expect(screen.getByText("Check spelling.")).toBeInTheDocument()
    expect(screen.queryByTestId("qr-svg")).not.toBeInTheDocument()
  })

  it("renders the success state with QR, address, and action buttons", () => {
    render(<PrintPaycodeView username="alice" />)

    // Address appears in both the on-screen view and the print-only poster.
    expect(screen.getAllByText(/alice@blink\.sv/).length).toBeGreaterThan(0)
    expect(screen.getByRole("button", { name: /Print QR Code/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Download PDF/i })).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /Copy Paycode LNURL/i }),
    ).toBeInTheDocument()
    // "Copy Lightning Address" was removed during the redesign.
    expect(
      screen.queryByRole("button", { name: /Copy Lightning Address/i }),
    ).not.toBeInTheDocument()
  })

  it("encodes the wrapped ?lightning= QR value (lowercased path)", () => {
    render(<PrintPaycodeView username="alice" />)
    const value = screen.getByTestId("qr-svg").getAttribute("data-value") || ""
    expect(value.startsWith("HTTPS://")).toBe(true)
    expect(value).toContain("/ALICE?LIGHTNING=LNURL1")
  })

  it("standalone Back navigates to the payee page", () => {
    render(<PrintPaycodeView username="alice" />)
    fireEvent.click(screen.getByRole("button", { name: /Back/i }))
    expect(mockPush).toHaveBeenCalledWith("/alice")
  })

  it("overlay Back calls onBack and does not navigate", () => {
    const onBack = jest.fn()
    render(<PrintPaycodeView username="alice" onBack={onBack} title="Paycodes" />)
    expect(screen.getByRole("heading", { name: "Paycodes" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Back/i }))
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(mockPush).not.toHaveBeenCalled()
  })
})
