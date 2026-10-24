/**
 * Side-effect module: import it FIRST in a tests/unit/pg spec
 * (`import "./env"`). lib/auth reads JWT_SECRET / ENCRYPTION_KEY at module
 * load, and the real stores encrypt API keys, so these must be set before any
 * lib/ module is imported. (import/order leaves side-effect imports where
 * they are, which is what keeps this one first.)
 */
process.env.JWT_SECRET ??= "pg-test-jwt-secret-0123456789abcdef"
process.env.ENCRYPTION_KEY ??= "pg-test-encryption-key-0123456789ab"

export {}
