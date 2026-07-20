/**
 * Check whether a LadybugDB error reports a missing schema table or column.
 * Callers may recover from these legacy-schema cases, but must propagate
 * connection, query, and other runtime failures.
 */
export const isMissingColumnOrTableError = (message: string): boolean =>
  message.includes('does not exist') ||
  // Kuzu-specific: "(table|column|property) ... not found" — narrow enough to avoid
  // matching transient errors like "connection not found" or "key not found".
  /(table|column|property).*not found/i.test(message);
