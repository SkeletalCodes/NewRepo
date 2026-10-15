'use strict';

/*
 * Paging for list endpoints. Pages are 1-based. Every paged query asks for one row more than the page
 * holds, so the response can say whether another page exists without a separate count.
 */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Page number and size from ?page= and ?limit=, clamped to sane values. */
function pageOf(query, size = DEFAULT_LIMIT, max = MAX_LIMIT) {
  const limit = Math.min(max, Math.max(1, parseInt(query.limit, 10) || size));
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  return { limit, page, offset: (page - 1) * limit };
}

/** Drop the extra row and return `{ [key]: items, page, hasMore }`. */
function pageRows(rows, { limit, page }, key = 'items') {
  const hasMore = rows.length > limit;
  return { [key]: hasMore ? rows.slice(0, limit) : rows, page, hasMore };
}

module.exports = { pageOf, pageRows };
