/**
 * Client-side paging state for the voucher manager (blink-wip#1617).
 *
 * GET /api/voucher/list returns pages newest first with a `nextCursor`. The
 * manager polls only the FIRST page and keeps older pages the user loaded
 * with "Load older vouchers" — those are refreshed only when reloaded (a
 * deliberate trade-off: the poll stays one page).
 *
 * Continuity: keeping the older pages is only correct if the refreshed first
 * page still reaches into what was loaded. New vouchers are created "now", so
 * they only ever appear at the top; if the refreshed page contains a voucher
 * that was already loaded, everything older than it is either loaded or has
 * since been deleted. If it contains none (more than a page of new vouchers
 * since the last poll, e.g. while the tab was hidden), keeping the old tail
 * would leave a silent gap — so the list resets to the first page instead.
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

/**
 * A (re)fetched first page. Without loaded older pages it replaces the list.
 * Otherwise, if it overlaps the loaded vouchers (see Continuity), it replaces
 * the part of the list it covers — new vouchers appear, changed ones update,
 * deleted ones (cleanup) disappear — and keeps the older loaded vouchers and
 * their cursor. Without overlap it resets to the first page and its cursor.
 */
export function applyFirstPage<T extends PagedVoucher>(
  prev: VoucherListState<T>,
  page: T[],
  nextCursor: string | null,
): VoucherListState<T> {
  const last = page[page.length - 1]
  const loaded = new Set(prev.vouchers.map((v) => v.id))
  const continuous = page.some((v) => loaded.has(v.id))
  // Not extended, the first page is now everything there is, or there is no
  // provable continuity with the loaded pages: start over from this page.
  if (!prev.extended || !last || nextCursor === null || !continuous) {
    return { vouchers: page, nextCursor, extended: false }
  }
  // The server breaks created_at ties by a hash the client does not have,
  // so ties at the boundary are kept (deduplicated) rather than guessed.
  const inPage = new Set(page.map((v) => v.id))
  const older = prev.vouchers.filter(
    (v) => !inPage.has(v.id) && v.createdAt <= last.createdAt,
  )
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
