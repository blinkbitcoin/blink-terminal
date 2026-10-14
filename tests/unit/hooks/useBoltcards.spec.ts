/**
 * useBoltcards: the card list is fetched for the session (cookie) owner; the
 * pubkey is never sent to the server.
 */

import { renderHook, waitFor } from "@testing-library/react"

import { useBoltcards } from "../../../components/boltcard/useBoltcards"

const fetchMock = jest.fn()

beforeEach(() => {
  fetchMock.mockReset()
  global.fetch = fetchMock as unknown as typeof fetch
})

it("lists cards via the session, without sending the pubkey", async () => {
  fetchMock.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ success: true, cards: [{ id: "c1" }] }),
  })

  const { result } = renderHook(() => useBoltcards("a".repeat(64)))

  await waitFor(() => expect(result.current.cards).toEqual([{ id: "c1" }]))
  expect(fetchMock).toHaveBeenCalledWith("/api/boltcard/cards")
  expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("a".repeat(64))
})

it("surfaces a 401 (no server session) as an error and an empty list", async () => {
  jest.spyOn(console, "error").mockImplementation(() => {})
  fetchMock.mockResolvedValue({
    ok: false,
    json: () => Promise.resolve({ error: "Authentication required" }),
  })

  const { result } = renderHook(() => useBoltcards("a".repeat(64)))

  await waitFor(() => expect(result.current.error).toBe("Authentication required"))
  expect(result.current.cards).toEqual([])
})

it("does not fetch without a signed-in pubkey", async () => {
  renderHook(() => useBoltcards(null))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(fetchMock).not.toHaveBeenCalled()
})
