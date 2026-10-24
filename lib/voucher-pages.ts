/**
 * Client-side paging state for the voucher manager (blink-wip#1617).
 *
 * GET /api/voucher/list returns pages newest first with a `nextCursor`. The
 * manager polls only the FIRST page and keeps older pages the user loaded
 * with "Load older vouchers". Order matches the API: (createdAt, id)
 * descending.
 */

export interface PagedVoucher {
  id: string
  createdAt: number
}

export interface VoucherListState<T extends PagedVoucher> {
  vouchers: T[]
  /** Cursor for the next (older) page; null when everything is loaded. */
  nextCursor: string | null
  /** True once older pages were loaded beyond the first. */
  extended: boolean
}

export const emptyVoucherList = <T extends PagedVoucher>(): VoucherListState<T> => ({
  vouchers: [],
  nextCursor: null,
  extended: false,
})

/** a is strictly older than b in the listing order. */
const isOlder = (a: PagedVoucher, b: PagedVoucher) =>
  a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id < b.id)

/**
 * A (re)fetched first page. Without loaded older pages it replaces the list.
 * Otherwise it replaces the part of the list it covers — new vouchers appear,
 * changed ones update, deleted ones (cleanup) disappear — and keeps the older
 * loaded vouchers and their cursor.
 */
export function applyFirstPage<T extends PagedVoucher>(
  prev: VoucherListState<T>,
  page: T[],
  nextCursor: string | null,
): VoucherListState<T> {
  const last = page[page.length - 1]
  // Not extended, or the first page is now everything there is.
  if (!prev.extended || !last || nextCursor === null) {
    return { vouchers: page, nextCursor, extended: false }
  }
  const inPage = new Set(page.map((v) => v.id))
  const older = prev.vouchers.filter((v) => !inPage.has(v.id) && isOlder(v, last))
  return { vouchers: [...page, ...older], nextCursor: prev.nextCursor, extended: true }
}

/** An older page loaded with the previous `nextCursor`. */
export function appendPage<T extends PagedVoucher>(
  prev: VoucherListState<T>,
  page: T[],
  nextCursor: string | null,
): VoucherListState<T> {
  const have = new Set(prev.vouchers.map((v) => v.id))
  return {
    vouchers: [...prev.vouchers, ...page.filter((v) => !have.has(v.id))],
    nextCursor,
    extended: true,
  }
}
