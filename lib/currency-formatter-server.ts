/**
 * Server-side currency formatting utilities
 * Simplified version for use in API routes
 *
 * IMPORTANT: Server-side always uses 'en-US' locale (1,234.56 format) for consistency.
 * This ensures payment memos and server-generated strings are universal.
 * Client-side formatting respects user's number format preference.
 */

// Server-side locale - always use en-US for consistency
const SERVER_LOCALE: string = "en-US"

// Common currency symbols mapping
const CURRENCY_SYMBOLS: Record<string, string> = {
  "USD": "$",
  "EUR": "€",
  "GBP": "£",
  "JPY": "¥",
  "CNY": "¥",
  "INR": "₹",
  "RUB": "₽",
  "NGN": "₦",
  "PHP": "₱",
  "UAH": "₴",
  "KZT": "₸",
  "TRY": "₺",
  "KRW": "₩",
  "ILS": "₪",
  "THB": "฿",
  "VND": "₫",
  "CRC": "₡",
  "GHS": "₵",
  "PYG": "₲",
  "ARS": "$",
  "AUD": "$",
  "CAD": "$",
  "NZD": "$",
  "HKD": "HK$",
  "SGD": "S$",
  "MXN": "$",
  "BRL": "R$",
  "ZAR": "R",
  "KES": "KSh",
  "TZS": "TSh",
  "UGX": "USh",
  "CHF": "CHF",
  "SEK": "kr",
  "NOK": "kr",
  "DKK": "kr.",
  "PLN": "zł",
  "CZK": "Kč",
  "HUF": "Ft",
  "RON": "RON",
  "BGN": "лв",
  "EGP": "E£",
  "MAD": "د.م.",
  "AED": "د.إ",
  "PKR": "₨",
  "BDT": "৳",
  "LKR": "Rs",
  "IDR": "Rp",
  "MYR": "RM",
  "BTC": "sats",
  "BTC-BIP177": "₿",
  // Citrusrate exclusive currencies (21: 20 African + VUV)
  "AOA": "Kz", // Angolan Kwanza
  "BIF": "FBu", // Burundian Franc
  "BWP": "P", // Botswana Pula
  "CDF": "FC", // Congolese Franc
  "CVE": "$", // Cape Verdean Escudo
  "DJF": "Fdj", // Djiboutian Franc
  "DZD": "د.ج", // Algerian Dinar
  "ERN": "Nfk", // Eritrean Nakfa
  "GMD": "D", // Gambian Dalasi
  "GNF": "FG", // Guinean Franc
  "KMF": "CF", // Comorian Franc
  "LSL": "L", // Lesotho Loti
  "LYD": "ل.د", // Libyan Dinar
  "MGA": "Ar", // Malagasy Ariary
  "RWF": "RF", // Rwandan Franc
  "SCR": "SR", // Seychellois Rupee
  "SDG": "ج.س", // Sudanese Pound
  "SOS": "S", // Somali Shilling
  "SZL": "E", // Swazi Lilangeni
  "TND": "د.ت", // Tunisian Dinar
  "VUV": "VT", // Vanuatu Vatu
}

// Currencies with 0 decimal places
// Note: Many African currencies like BIF, DJF, GNF, KMF, RWF, MGA are zero-decimal
const ZERO_DECIMAL_CURRENCIES: string[] = [
  "JPY",
  "KRW",
  "VND",
  "CLP",
  "PYG",
  "UGX",
  "XAF",
  "XOF",
  "XPF",
  "ALL",
  "LBP",
  "RSD",
  "HUF",
  "ISK",
  "TWD",
  "IDR",
  "IRR",
  "IQD",
  // Citrusrate exclusive zero-decimal currencies
  "BIF", // Burundian Franc
  "DJF", // Djiboutian Franc
  "GNF", // Guinean Franc
  "KMF", // Comorian Franc
  "MGA", // Malagasy Ariary
  "RWF", // Rwandan Franc
  "VUV", // Vanuatu Vatu
]

/**
 * Check if currency is Bitcoin (sats or BIP-177 format)
 * @param currencyId - Currency identifier
 * @returns True if Bitcoin currency
 */
function isBitcoinCurrency(currencyId: string): boolean {
  return currencyId === "BTC" || currencyId === "BTC-BIP177"
}

/**
 * Format currency amount for display on server-side
 * Always uses en-US locale (1,234.56) for consistent memos and API responses
 * @param value - Amount to format
 * @param currencyCode - Currency code (e.g., 'USD', 'EUR')
 * @returns Formatted currency string
 */
function formatCurrencyServer(value: number | string, currencyCode: string): string {
  const numValue: number = parseFloat(String(value)) || 0

  // Special handling for BTC/sats (traditional format: "10,000 sats")
  if (currencyCode === "BTC") {
    return `${numValue.toLocaleString(SERVER_LOCALE)} sats`
  }

  // Special handling for BTC-BIP177 (new format: "₿10,000")
  if (currencyCode === "BTC-BIP177") {
    return `₿${numValue.toLocaleString(SERVER_LOCALE)}`
  }

  // Get symbol and decimals
  const symbol: string = CURRENCY_SYMBOLS[currencyCode] || currencyCode
  const decimals: number = ZERO_DECIMAL_CURRENCIES.includes(currencyCode) ? 0 : 2

  // Format with en-US locale for consistent thousands separators
  const formattedAmount: string = numValue.toLocaleString(SERVER_LOCALE, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })

  // Determine if space is needed between symbol and amount
  const needsSpace: boolean =
    symbol.length > 1 &&
    ![
      "$",
      "£",
      "€",
      "¥",
      "₹",
      "₽",
      "₦",
      "₱",
      "₴",
      "₸",
      "₺",
      "₩",
      "₪",
      "฿",
      "₫",
      "₡",
      "₵",
      "₲",
      "ƒ",
    ].includes(symbol)

  return needsSpace ? `${symbol} ${formattedAmount}` : `${symbol}${formattedAmount}`
}

export {
  formatCurrencyServer,
  isBitcoinCurrency,
  CURRENCY_SYMBOLS,
  ZERO_DECIMAL_CURRENCIES,
  SERVER_LOCALE,
}
