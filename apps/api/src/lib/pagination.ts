/**
 * Keyset pagination over time-ordered ids (ULIDs sort by creation time).
 * Responses: { object: "list", data, has_more, next_cursor }. Pass next_cursor as `starting_after`.
 */
export function page<T extends { id: string }>(rows: T[], limit: number, map: (row: T) => unknown = (r) => r) {
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  return { object: "list", data: slice.map(map), has_more: hasMore, next_cursor: hasMore ? slice[slice.length - 1]!.id : null };
}

/** Build `AND id < $n` for newest-first lists. Returns the SQL fragment and pushes the param. */
export function cursorClause(params: unknown[], startingAfter: string | undefined, column = "id", direction: "desc" | "asc" = "desc"): string {
  if (!startingAfter) return "";
  params.push(startingAfter);
  return ` AND ${column} ${direction === "desc" ? "<" : ">"} $${params.length}`;
}
