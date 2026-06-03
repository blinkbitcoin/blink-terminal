/**
 * ConnectionManager - Platform detection and adapter selection
 *
 * Detects the current platform capabilities and selects the best
 * printing adapter(s) available. Handles the fallback chain:
 *
 * Mobile:
 *   1. Companion App (deep link) - Primary for mobile
 *   2. PDF fallback
 *
 * Desktop Chrome/Edge:
 *   1. Web Serial (USB) - Direct connection
 *   2. WebSocket bridge - For network printers
 *   3. PDF fallback
 *
 * Desktop Firefox/Safari:
 *   1. WebSocket bridge
 *   2. PDF fallback
 *
 * Features:
 * - Platform and browser detection
 * - Capability probing
 * - Adapter prioritization
 * - Fallback chain management
 * - User preference persistence
 */

import type BaseAdapter from "./adapters/BaseAdapter"
import CompanionAdapter from "./adapters/CompanionAdapter"
import LocalPrintAdapter from "./adapters/LocalPrintAdapter"
import PDFAdapter from "./adapters/PDFAdapter"
import WebSerialAdapter from "./adapters/WebSerialAdapter"

interface PlatformCapabilities {
  webSerial: boolean
  webBluetooth: boolean
  webUSB: boolean
  serviceWorker: boolean
  nativeShare: boolean
  clipboard: boolean
}

interface PlatformInfo {
  platform: string
  browser: string
  deviceType: string
  userAgent: string
  capabilities: PlatformCapabilities
}

interface AdapterInfo {
  type: string
  adapter: BaseAdapter
  available: boolean
  priority: number
  recommended: boolean
}

interface PrintPreferences {
  preferredAdapter?: string
  [key: string]: unknown
}

interface RecommendationMethod {
  type: string
  name: string
  recommended: boolean
}

interface Recommendations {
  platform: PlatformInfo
  primaryMethod: string | null
  fallbackMethod: string | null
  availableMethods: RecommendationMethod[]
  tips: string[]
}

type EventCallback = (data: Record<string, unknown>) => void

/**
 * Platform types
 */
const Platform = {
  IOS: "ios",
  ANDROID: "android",
  WINDOWS: "windows",
  MACOS: "macos",
  LINUX: "linux",
  UNKNOWN: "unknown",
} as const

/**
 * Browser types
 */
const Browser = {
  CHROME: "chrome",
  EDGE: "edge",
  FIREFOX: "firefox",
  SAFARI: "safari",
  SAMSUNG: "samsung",
  OPERA: "opera",
  UNKNOWN: "unknown",
} as const

/**
 * Device types
 */
const DeviceType = {
  MOBILE: "mobile",
  TABLET: "tablet",
  DESKTOP: "desktop",
} as const

/**
 * Adapter priorities (lower = higher priority)
 */
const ADAPTER_PRIORITY: Record<string, number> = {
  localprint: 1, // Best for desktop with local print server
  companion: 2, // Best for mobile
  webserial: 3, // Desktop USB (requires user gesture)
  websocket: 4, // Network printers
  pdf: 100, // Always available fallback
}

/**
 * ConnectionManager class
 */
class ConnectionManager {
  _platformInfo: PlatformInfo | null
  _adapters: Map<string, BaseAdapter>
  _activeAdapter: BaseAdapter | null
  _preferences: PrintPreferences
  _eventListeners: Map<string, Set<EventCallback>>

  constructor() {
    // Cached platform info
    this._platformInfo = null

    // Available adapter instances
    this._adapters = new Map()

    // Active adapter
    this._activeAdapter = null

    // User preferences (stored in localStorage)
    this._preferences = this._loadPreferences()

    // Event listeners
    this._eventListeners = new Map()
  }

  // ============================================================
  // PLATFORM DETECTION
  // ============================================================

  /**
   * Get comprehensive platform information
   * @returns {object}
   */
  getPlatformInfo(): PlatformInfo {
    if (this._platformInfo) {
      return this._platformInfo
    }

    if (typeof navigator === "undefined") {
      this._platformInfo = {
        platform: Platform.UNKNOWN,
        browser: Browser.UNKNOWN,
        deviceType: DeviceType.DESKTOP,
        userAgent: "",
        capabilities: {
          webSerial: false,
          webBluetooth: false,
          webUSB: false,
          serviceWorker: false,
          nativeShare: false,
          clipboard: false,
        },
      }
      return this._platformInfo
    }

    const ua = navigator.userAgent

    this._platformInfo = {
      platform: this._detectPlatform(ua),
      browser: this._detectBrowser(ua),
      deviceType: this._detectDeviceType(ua),
      userAgent: ua,
      capabilities: {
        webSerial: "serial" in navigator,
        webBluetooth: "bluetooth" in navigator,
        webUSB: "usb" in navigator,
        serviceWorker: "serviceWorker" in navigator,
        nativeShare: !!navigator.share,
        clipboard: !!navigator.clipboard,
      },
    }

    return this._platformInfo
  }

  /**
   * Detect operating system/platform
   * @private
   */
  _detectPlatform(ua: string): string {
    if (/iPhone|iPad|iPod/i.test(ua)) return Platform.IOS
    if (/Android/i.test(ua)) return Platform.ANDROID
    if (/Windows/i.test(ua)) return Platform.WINDOWS
    if (/Mac/i.test(ua)) return Platform.MACOS
    if (/Linux/i.test(ua)) return Platform.LINUX
    return Platform.UNKNOWN
  }

  /**
   * Detect browser
   * @private
   */
  _detectBrowser(ua: string): string {
    if (/Edg\//i.test(ua)) return Browser.EDGE
    if (/Chrome/i.test(ua) && !/Edg/i.test(ua)) return Browser.CHROME
    if (/Firefox/i.test(ua)) return Browser.FIREFOX
    if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) return Browser.SAFARI
    if (/SamsungBrowser/i.test(ua)) return Browser.SAMSUNG
    if (/Opera|OPR/i.test(ua)) return Browser.OPERA
    return Browser.UNKNOWN
  }

  /**
   * Detect device type
   * @private
   */
  _detectDeviceType(ua: string): string {
    if (/Tablet|iPad/i.test(ua)) return DeviceType.TABLET
    if (/Mobile|iPhone|Android/i.test(ua)) return DeviceType.MOBILE
    return DeviceType.DESKTOP
  }

  /**
   * Check if on mobile device
   * @returns {boolean}
   */
  isMobile(): boolean {
    const info = this.getPlatformInfo()
    return info.deviceType === DeviceType.MOBILE || info.deviceType === DeviceType.TABLET
  }

  /**
   * Check if on desktop
   * @returns {boolean}
   */
  isDesktop(): boolean {
    return this.getPlatformInfo().deviceType === DeviceType.DESKTOP
  }

  /**
   * Check if Web Serial is supported
   * @returns {boolean}
   */
  hasWebSerial(): boolean {
    return this.getPlatformInfo().capabilities.webSerial
  }

  // ============================================================
  // ADAPTER MANAGEMENT
  // ============================================================

  /**
   * Get all available adapters for current platform
   * @returns {Promise<Array<{adapter: BaseAdapter, available: boolean, priority: number}>>}
   */
  async getAvailableAdapters(): Promise<AdapterInfo[]> {
    const info = this.getPlatformInfo()
    const results: AdapterInfo[] = []

    // Create adapter instances if not cached
    if (!this._adapters.has("localprint")) {
      this._adapters.set("localprint", new LocalPrintAdapter())
    }
    if (!this._adapters.has("companion")) {
      this._adapters.set("companion", new CompanionAdapter())
    }
    if (!this._adapters.has("webserial")) {
      this._adapters.set("webserial", new WebSerialAdapter())
    }
    if (!this._adapters.has("pdf")) {
      this._adapters.set("pdf", new PDFAdapter())
    }

    // Check each adapter
    for (const [type, adapter] of this._adapters) {
      const available = await adapter.isAvailable()
      results.push({
        type,
        adapter,
        available,
        priority: ADAPTER_PRIORITY[type] || 99,
        recommended: this._isRecommended(type, info),
      })
    }

    // Sort by priority (lower = better)
    results.sort((a, b) => a.priority - b.priority)

    return results
  }

  /**
   * Check if an adapter is recommended for current platform
   * @private
   */
  _isRecommended(type: string, info: PlatformInfo): boolean {
    // Desktop with local print server: LocalPrint is best
    if (this.isDesktop() && type === "localprint") {
      return true
    }

    // Mobile: Companion app is best
    if (this.isMobile() && type === "companion") {
      return true
    }

    // Desktop Chrome/Edge: Web Serial is good for USB printers
    if (
      this.isDesktop() &&
      (info.browser === Browser.CHROME || info.browser === Browser.EDGE) &&
      type === "webserial"
    ) {
      return true
    }

    // Desktop Firefox/Safari: WebSocket or PDF
    if (
      this.isDesktop() &&
      (info.browser === Browser.FIREFOX || info.browser === Browser.SAFARI)
    ) {
      return type === "websocket" || type === "pdf"
    }

    return false
  }

  /**
   * Get the best available adapter for current platform
   * @returns {Promise<BaseAdapter>}
   */
  async getBestAdapter(): Promise<BaseAdapter> {
    // Check user preference first
    const preferredType = this._preferences.preferredAdapter
    if (preferredType && this._adapters.has(preferredType)) {
      const preferred = this._adapters.get(preferredType)!
      if (await preferred.isAvailable()) {
        return preferred
      }
    }

    // Get available adapters sorted by priority
    const adapters = await this.getAvailableAdapters()

    // Find first available (excluding PDF unless it's the only option)
    for (const { adapter, available, type } of adapters) {
      if (available && type !== "pdf") {
        return adapter
      }
    }

    // Fall back to PDF
    return this._adapters.get("pdf")!
  }

  /**
   * Get a specific adapter by type
   * @param {string} type - Adapter type ('companion', 'webserial', 'pdf', etc.)
   * @returns {BaseAdapter|null}
   */
  getAdapter(type: string): BaseAdapter | null {
    return this._adapters.get(type) || null
  }

  /**
   * Set the active adapter
   * @param {string|BaseAdapter} adapterOrType
   * @returns {Promise<boolean>}
   */
  async setActiveAdapter(adapterOrType: string | BaseAdapter): Promise<boolean> {
    let adapter: BaseAdapter

    if (typeof adapterOrType === "string") {
      const found = this._adapters.get(adapterOrType)
      if (!found) {
        throw new Error(`Unknown adapter type: ${adapterOrType}`)
      }
      adapter = found
    } else {
      adapter = adapterOrType
    }

    if (!(await adapter.isAvailable())) {
      throw new Error(`Adapter ${adapter.type} is not available`)
    }

    this._activeAdapter = adapter
    this._preferences.preferredAdapter = adapter.type
    this._savePreferences()

    this._emit("adapterChanged", { adapter })

    return true
  }

  /**
   * Get the currently active adapter
   * @returns {Promise<BaseAdapter>}
   */
  async getActiveAdapter(): Promise<BaseAdapter> {
    if (!this._activeAdapter) {
      this._activeAdapter = await this.getBestAdapter()
    }
    return this._activeAdapter
  }

  /**
   * Get the best available adapter that is NOT the PDF fallback.
   *
   * The PDF adapter is voucher-only (it ignores ESC/POS bytes and renders a
   * voucher PDF), so receipt printing must never route to it — even if the user
   * previously selected PDF as their preferred method for vouchers.
   *
   * Honors the user's preferred adapter when it is available and non-PDF;
   * otherwise picks the highest-priority available non-PDF adapter.
   *
   * @returns {Promise<BaseAdapter|null>} a non-PDF adapter, or null if none available
   */
  async getBestNonPdfAdapter(): Promise<BaseAdapter | null> {
    const adapters = await this.getAvailableAdapters()

    // Prefer the user's chosen adapter if it's available and not PDF.
    const preferredType = this._preferences.preferredAdapter
    if (preferredType && preferredType !== "pdf") {
      const preferred = adapters.find((a) => a.type === preferredType && a.available)
      if (preferred) return preferred.adapter
    }

    // Otherwise the highest-priority available non-PDF adapter.
    const best = adapters.find((a) => a.available && a.type !== "pdf")
    return best ? best.adapter : null
  }

  // ============================================================
  // RECOMMENDATION ENGINE
  // ============================================================

  /**
   * Get printing recommendations for current platform
   * @returns {Promise<object>}
   */
  async getRecommendations(): Promise<Recommendations> {
    const info = this.getPlatformInfo()
    const adapters = await this.getAvailableAdapters()

    const recommendations: Recommendations = {
      platform: info,
      primaryMethod: null,
      fallbackMethod: null,
      availableMethods: [],
      tips: [],
    }

    // Determine available methods
    for (const { adapter, available, recommended } of adapters) {
      if (available) {
        recommendations.availableMethods.push({
          type: adapter.type,
          name: adapter.name,
          recommended,
        })

        if (recommended && !recommendations.primaryMethod) {
          recommendations.primaryMethod = adapter.type
        }
      }
    }

    // PDF is always the fallback
    recommendations.fallbackMethod = "pdf"

    // Add platform-specific tips
    if (this.isMobile()) {
      if (info.platform === Platform.IOS) {
        recommendations.tips.push(
          "Install the Blink POS Companion app for best thermal printing experience",
          "iOS does not support direct Bluetooth printer access from browsers",
        )
      } else if (info.platform === Platform.ANDROID) {
        recommendations.tips.push(
          "Use the Blink POS Companion app for Bluetooth thermal printing",
          "Alternative: RawBT app supports ESC/POS printing",
        )
      }
    } else if (this.isDesktop()) {
      if (info.capabilities.webSerial) {
        recommendations.tips.push(
          "Connect your USB thermal printer for direct printing",
          "Most thermal printers work out of the box with Web Serial",
        )
      } else {
        recommendations.tips.push(
          "Use Chrome or Edge for direct USB printer support",
          "PDF printing is available as a fallback",
        )
      }
    }

    return recommendations
  }

  // ============================================================
  // PREFERENCES
  // ============================================================

  /**
   * Load preferences from localStorage
   * @private
   */
  _loadPreferences(): PrintPreferences {
    if (typeof localStorage === "undefined") {
      return {}
    }

    try {
      const stored = localStorage.getItem("blink-print-preferences")
      return stored ? (JSON.parse(stored) as PrintPreferences) : {}
    } catch (_e) {
      return {}
    }
  }

  /**
   * Save preferences to localStorage
   * @private
   */
  _savePreferences(): void {
    if (typeof localStorage === "undefined") {
      return
    }

    try {
      localStorage.setItem("blink-print-preferences", JSON.stringify(this._preferences))
    } catch (_e) {
      console.warn("Could not save print preferences:", _e)
    }
  }

  /**
   * Get user preferences
   * @returns {object}
   */
  getPreferences(): PrintPreferences {
    return { ...this._preferences }
  }

  /**
   * Update user preferences
   * @param {object} prefs
   */
  setPreferences(prefs: PrintPreferences): void {
    this._preferences = { ...this._preferences, ...prefs }
    this._savePreferences()
  }

  /**
   * Clear all preferences
   */
  clearPreferences(): void {
    this._preferences = {}
    this._savePreferences()
  }

  // ============================================================
  // EVENT SYSTEM
  // ============================================================

  /**
   * Add event listener
   * @param {string} event
   * @param {function} callback
   * @returns {function} Unsubscribe function
   */
  on(event: string, callback: EventCallback): () => void {
    if (!this._eventListeners.has(event)) {
      this._eventListeners.set(event, new Set())
    }
    this._eventListeners.get(event)!.add(callback)
    return () => this.off(event, callback)
  }

  /**
   * Remove event listener
   * @param {string} event
   * @param {function} callback
   */
  off(event: string, callback: EventCallback): void {
    const listeners = this._eventListeners.get(event)
    if (listeners) {
      listeners.delete(callback)
    }
  }

  /**
   * Emit event
   * @private
   */
  _emit(event: string, data: Record<string, unknown> = {}): void {
    const listeners = this._eventListeners.get(event)
    if (listeners) {
      listeners.forEach((cb) => {
        try {
          cb(data)
        } catch (_e) {
          console.error("Error in ConnectionManager event handler:", _e)
        }
      })
    }
  }

  // ============================================================
  // UTILITIES
  // ============================================================

  /**
   * Get debug info
   * @returns {object}
   */
  getDebugInfo(): Record<string, unknown> {
    return {
      platformInfo: this.getPlatformInfo(),
      preferences: this._preferences,
      activeAdapter: this._activeAdapter?.type || null,
      adapters: Array.from(this._adapters.keys()),
    }
  }
}

// Singleton instance
let _instance: ConnectionManager | null = null

/**
 * Get the singleton ConnectionManager instance
 * @returns {ConnectionManager}
 */
function getConnectionManager(): ConnectionManager {
  if (!_instance) {
    _instance = new ConnectionManager()
  }
  return _instance
}

export default ConnectionManager
export { ConnectionManager, getConnectionManager, Platform, Browser, DeviceType }
export type {
  PlatformCapabilities,
  PlatformInfo,
  AdapterInfo,
  PrintPreferences,
  RecommendationMethod,
  Recommendations,
  EventCallback,
}
