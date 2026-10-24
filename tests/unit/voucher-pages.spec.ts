/**
 * Voucher manager paging (blink-wip#1617): the poll refreshes only the first
 * page; older pages loaded with "Load older vouchers" are kept.
 */

import {
  appendPage,
  applyFirstPage,
  emptyVoucherList,
  updateVoucher,
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

  it("a voucher deleted from inside a timestamp tie does not come back (review repro)", () => {
    // Loaded [A(5), B(5)] + [C(5), D(4)]; cleanup deletes A; the refreshed
    // first page is [B(5), C(5)]. A timestamp-only merge kept A ("5 <= 5").
    let s = applyFirstPage(emptyVoucherList<V>(), [v("A", 5), v("B", 5)], "5_x")
    s = appendPage(s, [v("C", 5), v("D", 4)], "4_y")
    s = applyFirstPage(s, [v("B", 5), v("C", 5)], "5_z")
    expect(ids(s)).toEqual(["B", "C", "D"])
    expect(s.nextCursor).toBe("4_y")
  })

  it("a deletion right at the page boundary inside a tie is dropped too", () => {
    let s = applyFirstPage(emptyVoucherList<V>(), [v("A", 5), v("B", 5)], "5_x")
    s = appendPage(s, [v("C", 5), v("D", 5), v("E", 4)], "4_y")
    // C was deleted; the refreshed page ends at D.
    s = applyFirstPage(s, [v("B", 5), v("D", 5)], "5_z")
    expect(ids(s)).toEqual(["B", "D", "E"])
  })

  it("a refreshed page that reaches PAST the loaded vouchers resets — distinct timestamps (review repro)", () => {
    // Loaded [A5,B4] + [C3,D2] (cursor after D). Cleanup deletes A, B and D;
    // the refreshed page [C3,E1] ends on E, which was never loaded.
    let s = applyFirstPage(emptyVoucherList<V>(), [v("A", 5), v("B", 4)], "4_b")
    s = appendPage(s, [v("C", 3), v("D", 2)], "2_d")
    s = applyFirstPage(s, [v("C", 3), v("E", 1)], "1_e")
    // Not [C, E, D] with the stale cursor: D is deleted.
    expect(s).toEqual({
      vouchers: [v("C", 3), v("E", 1)],
      nextCursor: "1_e",
      extended: false,
    })
  })

  it("a refreshed page that reaches PAST the loaded vouchers resets — tied timestamps", () => {
    let s = applyFirstPage(emptyVoucherList<V>(), [v("A", 5), v("B", 5)], "5_b")
    s = appendPage(s, [v("C", 5), v("D", 5)], "5_d")
    // A, B and D deleted; E (same created_at, later in the tie order) was never loaded.
    s = applyFirstPage(s, [v("C", 5), v("E", 5)], "5_e")
    expect(s).toEqual({
      vouchers: [v("C", 5), v("E", 5)],
      nextCursor: "5_e",
      extended: false,
    })
  })

  it("new vouchers before the anchor are ordinary new vouchers", () => {
    let s = applyFirstPage(emptyVoucherList<V>(), [v("c", 3), v("b", 2)], "2_b")
    s = appendPage(s, [v("a", 1)], "1_a")
    s = applyFirstPage(s, [v("d", 4), v("b", 2)], "2_b") // c deleted, d new
    expect(ids(s)).toEqual(["d", "b", "a"])
    expect(s).toMatchObject({ nextCursor: "1_a", extended: true })
  })

  it("updateVoucher patches one loaded voucher (e.g. cancelled on an older page)", () => {
    let s = applyFirstPage(emptyVoucherList<V>(), [v("c", 3)], "3_c")
    s = appendPage(s, [v("b", 2), v("a", 1)], null)
    const next = updateVoucher(s, "a", { status: "CANCELLED" })
    expect(next.vouchers.map((x) => `${x.id}:${x.status}`)).toEqual([
      "c:ACTIVE",
      "b:ACTIVE",
      "a:CANCELLED",
    ])
    expect(next.nextCursor).toBe(s.nextCursor)
    expect(updateVoucher(s, "zz", { status: "CANCELLED" })).toBe(s) // not loaded: no-op
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
