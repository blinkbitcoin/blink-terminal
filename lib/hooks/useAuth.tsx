import {
  useState,
  useEffect,
  useRef,
  createContext,
  useContext,
  type JSX,
  type ReactNode,
} from "react"

// ─── Types ────────────────────────────────────────────────────────

export interface User {
  username: string
  [key: string]: unknown
}

export interface LoginResult {
  success: boolean
  error?: string
}

export interface AuthContextValue {
  user: User | null
  loading: boolean
  login: (username: string, apiKey: string) => Promise<LoginResult>
  logout: () => Promise<void>
  isAuthenticated: boolean
}

interface AuthProviderProps {
  children: ReactNode
}

// ─── Context ──────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({ children }: AuthProviderProps): JSX.Element {
  const [user, setUser] = useState<User | null>(null)
  // Start with loading: true since we always check auth on mount
  const [loading, setLoading] = useState<boolean>(true)

  // Track if auth check has been initiated to handle React Strict Mode
  const authCheckInitiated = useRef<boolean>(false)

  // Check authentication status on mount
  useEffect(() => {
    // Only run on client side
    if (typeof window !== "undefined") {
      // In React Strict Mode, effects run twice. Only initiate auth check once.
      if (authCheckInitiated.current) {
        return
      }
      authCheckInitiated.current = true
      checkAuth()
    } else {
      setLoading(false)
    }
  }, [])

  const checkAuth = async (): Promise<void> => {
    // Add timeout to prevent hanging
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 5000) // 5 second timeout

    try {
      const response = await fetch("/api/auth/verify", {
        signal: controller.signal,
      })

      if (response.ok) {
        const data = await response.json()
        setUser(data.user)
      } else {
        setUser(null)
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        console.error("Auth check timed out")
      } else {
        console.error("Auth check failed:", error)
      }
      setUser(null)
    } finally {
      clearTimeout(timeoutId)
      setLoading(false)
    }
  }

  const login = async (username: string, apiKey: string): Promise<LoginResult> => {
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username, apiKey }),
      })

      const data = await response.json()

      if (response.ok) {
        setUser(data.user)
        return { success: true }
      } else {
        return { success: false, error: data.error }
      }
    } catch (error: unknown) {
      console.error("Login failed:", error)
      return { success: false, error: "Login failed" }
    }
  }

  const logout = async (): Promise<void> => {
    try {
      await fetch("/api/auth/logout", { method: "POST" })
      setUser(null)
    } catch (error: unknown) {
      console.error("Logout failed:", error)
    }
  }

  const value: AuthContextValue = {
    user,
    loading,
    login,
    logout,
    isAuthenticated: !!user,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider")
  }
  return context
}
