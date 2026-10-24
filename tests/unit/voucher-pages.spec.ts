/**
 * Voucher manager paging (blink-wip#1617): the poll refreshes only the first
 * page; older pages loaded with "Load older vouchers" are kept.
 */

import {
  appendPage,
  applyFirstPage,
  emptyVoucherList,
  type VoucherListState,
} from "../../lib/voucher-pages"

interface V {
  id: string
  createdAt: number
  status?: string
}

const v = (id: string, createdAt: number, status = "ACTIVE"): V => ({
  id,
  createdAt,
  status,
})
const ids = (s: VoucherListState<V>) => s.vouchers.map((x) => x.id)

describe("voucher list paging", () => {
  it("first load replaces the list and keeps the cursor", () => {
    const s = applyFirstPage(emptyVoucherList<V>(), [v("c", 3), v("b", 2)], "2_b")
    expect(s).toEqual({
      vouchers: [v("c", 3), v("b", 2)],
      nextCursor: "2_b",
      extended: false,
    })
  })

  it("load more appends the older page (deduplicated) and advances the cursor", () => {
    let s = applyFirstPage(emptyVoucherList<V>(), [v("c", 3), v("b", 2)], "2_b")
    s = appendPage(s, [v("b", 2), v("a", 1)], null)
    expect(ids(s)).toEqual(["c", "b", "a"])
    expect(s).toMatchObject({ nextCursor: null, extended: true })
  })

  it("a poll after loading more keeps the older pages and their cursor", () => {
    let s = applyFirstPage(emptyVoucherList<V>(), [v("e", 5), v("d", 4)], "4_d")
    s = appendPage(s, [v("c", 3), v("b", 2)], "2_b")
    // A new voucher "f" was created and "d" was claimed; the first page shifts.
    s = applyFirstPage(s, [v("f", 6), v("e", 5)], "5_e")
    expect(ids(s)).toEqual(["f", "e", "d", "c", "b"])
    expect(s.nextCursor).toBe("2_b") // still continues after the oldest loaded
    s = applyFirstPage(s, [v("f", 6), v("e", 5, "CLAIMED")], "5_e")
    expect(s.vouchers[1].status).toBe("CLAIMED") // updates come through
  })

  it("a poll drops loaded vouchers inside its window that no longer exist", () => {
    let s = applyFirstPage(emptyVoucherList<V>(), [v("e", 5), v("d", 4)], "4_d")
    s = appendPage(s, [v("c", 3)], "3_c")
    s = applyFirstPage(s, [v("e", 5), v("c", 3)], "3_c") // "d" was cleaned up
    expect(ids(s)).toEqual(["e", "c"])
  })

  it("vouchers sharing the boundary createdAt are kept, never duplicated", () => {
    let s = applyFirstPage(emptyVoucherList<V>(), [v("z", 5), v("y", 5)], "5_y")
    s = appendPage(s, [v("x", 5), v("w", 4)], "4_w")
    s = applyFirstPage(s, [v("z", 5), v("y", 5)], "5_y")
    expect(ids(s)).toEqual(["z", "y", "x", "w"])
  })

  it("a refreshed page that no longer reaches the loaded pages resets (no silent gap) — cursor remaining", () => {
    // Loaded: e d | c b (cursor after b). Then 3+ new vouchers arrive (e.g. tab
    // hidden): the new first page h g has none of the loaded ids, and f, e, d
    // sit between it and the old tail.
    let s = applyFirstPage(emptyVoucherList<V>(), [v("e", 5), v("d", 4)], "4_d")
    s = appendPage(s, [v("c", 3), v("b", 2)], "2_b")
    s = applyFirstPage(s, [v("h", 8), v("g", 7)], "7_g")
    expect(s).toEqual({
      vouchers: [v("h", 8), v("g", 7)],
      nextCursor: "7_g",
      extended: false,
    })
  })

  it("a refreshed page that no longer reaches the loaded pages resets — cursor already exhausted", () => {
    let s = applyFirstPage(emptyVoucherList<V>(), [v("e", 5), v("d", 4)], "4_d")
    s = appendPage(s, [v("c", 3)], null) // everything was loaded
    s = applyFirstPage(s, [v("h", 8), v("g", 7)], "7_g")
    // Without the reset the button would be gone and f, e, d unreachable.
    expect(s).toEqual({
      vouchers: [v("h", 8), v("g", 7)],
      nextCursor: "7_g",
      extended: false,
    })
  })

  it("one shared voucher is enough continuity to keep the older pages", () => {
    let s = applyFirstPage(emptyVoucherList<V>(), [v("e", 5), v("d", 4)], "4_d")
    s = appendPage(s, [v("c", 3)], "3_c")
    s = applyFirstPage(s, [v("f", 6), v("e", 5)], "5_e")
    expect(ids(s)).toEqual(["f", "e", "d", "c"])
    expect(s).toMatchObject({ nextCursor: "3_c", extended: true })
  })

  it("a poll whose first page is now everything resets to a single page", () => {
    let s = applyFirstPage(emptyVoucherList<V>(), [v("c", 3)], "3_c")
    s = appendPage(s, [v("b", 2)], null)
    s = applyFirstPage(s, [v("c", 3)], null) // "b" was cleaned up
    expect(s).toEqual({ vouchers: [v("c", 3)], nextCursor: null, extended: false })
  })

  it("an empty first page empties the list", () => {
    let s = applyFirstPage(emptyVoucherList<V>(), [v("c", 3)], "3_c")
    s = appendPage(s, [v("b", 2)], null)
    expect(applyFirstPage(s, [], null)).toEqual(emptyVoucherList())
  })
})
