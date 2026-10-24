/**
 * Client-side paging state for the voucher manager (blink-wip#1617).
 *
 * GET /api/voucher/list returns pages newest first with a `nextCursor`. The
 * manager polls only the FIRST page and keeps older pages the user loaded
 * with "Load older vouchers" — those are refreshed only when reloaded (a
 * deliberate trade-off: the poll stays one page).
 *
 * Continuity: the older loaded pages are kept only if the refreshed first
 * page ENDS on a voucher that was already loaded (the anchor). The loaded list
 * is in server order and new vouchers are created "now", so they only ever
 * appear at the top: everything older than the anchor is then either loaded
 * (after it in the list) or has since been deleted — nothing unloaded can sit
 * in between, so the loaded tail after the anchor continues the page exactly.
 * Otherwise the list resets to the refreshed page and its cursor:
 * - no overlap at all (more than a page of new vouchers since the last poll,
 *   e.g. while the tab was hidden): keeping the tail would leave a gap;
 * - the page reaches PAST what was loaded (cleanup deleted enough rows that
 *   it ends on a never-loaded voucher): keeping the tail would resurrect
 *   deleted vouchers behind a stale cursor.
 *
 * Ordering is never modelled here — positions only, no timestamp comparison,
 * which could not reproduce the server's tiebreak for equal created_at. The
 * older loaded pages are refreshed only when reloaded (a deliberate
 * trade-off: the poll stays one page).
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
 * Otherwise, if it ends on a loaded voucher (see Continuity), it replaces the
 * part of the list it covers — new vouchers appear, changed ones update,
 * deleted ones (cleanup) disappear — and keeps the vouchers loaded after it
 * and their cursor. Otherwise it resets to the first page and its cursor.
 */
export function applyFirstPage<T extends PagedVoucher>(
  prev: VoucherListState<T>,
  page: T[],
  nextCursor: string | null,
): VoucherListState<T> {
  const inPage = new Set(page.map((v) => v.id))
  const last = page[page.length - 1]
  // Anchor: the refreshed page's last voucher, in the loaded list.
  const anchor = last ? prev.vouchers.findIndex((v) => v.id === last.id) : -1
  // Not extended, the first page is now everything there is, or no provable
  // continuity (no overlap, or the page reaches past what was loaded):
  // start over from this page.
  if (!prev.extended || nextCursor === null || anchor < 0) {
    return { vouchers: page, nextCursor, extended: false }
  }
  // Everything loaded after the anchor is older than the refreshed page;
  // anything before it that the page no longer contains was deleted.
  const older = prev.vouchers.slice(anchor + 1).filter((v) => !inPage.has(v.id))
  return { vouchers: [...page, ...older], nextCursor: prev.nextCursor, extended: true }
}

/**
 * Apply a change the server confirmed for one loaded voucher (e.g. a
 * successful cancel). Needed for vouchers on older pages, which the
 * first-page poll does not refresh. No-op when the voucher is not loaded.
 */
export function updateVoucher<T extends PagedVoucher>(
  prev: VoucherListState<T>,
  id: string,
  patch: Partial<T>,
): VoucherListState<T> {
  if (!prev.vouchers.some((v) => v.id === id)) return prev
  return {
    ...prev,
    vouchers: prev.vouchers.map((v) => (v.id === id ? { ...v, ...patch } : v)),
  }
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
