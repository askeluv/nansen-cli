/**
 * Nansen CLI - Shared list-query helpers
 *
 * Builds pagination and order_by request fragments from CLI options.
 * Lives in a leaf module so src/cli.js and src/commands/*.js share one
 * implementation without circular imports.
 */

import { NansenError, ErrorCode } from './api.js';

export function buildPagination(options) {
  if (options.limit === undefined && options.page === undefined) return undefined;
  const perPage = options.limit === undefined ? undefined : Number(options.limit);
  if (perPage !== undefined && (!Number.isInteger(perPage) || perPage < 1)) {
    throw new NansenError('--limit must be a positive integer', ErrorCode.INVALID_PARAMS);
  }
  return {
    page: Math.max(1, parseInt(options.page, 10) || 1),
    per_page: perPage,
  };
}

// Parse simple sort syntax: "field:direction" or "field" (defaults to DESC)
export function parseSort(sortOption, orderByOption) {
  // If --order-by is provided, use it (full JSON control)
  if (orderByOption) return orderByOption;
  if (!sortOption) return undefined;
  const parts = String(sortOption).split(':');
  const field = parts[0];
  const direction = (parts[1] || 'desc').toUpperCase();
  return [{ field, direction }];
}
