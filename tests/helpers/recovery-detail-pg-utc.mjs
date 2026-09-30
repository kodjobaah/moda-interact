import pg from "pg";

// Test-only adapter: Prisma models timestamp-without-time-zone values as UTC.
// pg otherwise decodes/encodes these using the host zone. Keep the override local
// to this Client rather than mutating pg's global parser registry.
export const recoveryDetailPgTypes = {
  /** @param {number} oid @param {"text"|"binary"} [format] */
  getTypeParser(oid, format) {
    if (oid === 1114 && format !== "binary") {
      /** @param {string} value */
      return (value) => new Date(`${value.replace(" ", "T")}Z`);
    }
    return pg.types.getTypeParser(oid, format);
  },
};

// Sending an ISO string avoids pg's host-local Date serializer. The production
// query's ::timestamp cast reads its UTC wall-clock fields, exactly as intended.
/** @param {unknown[]} values */
export function recoveryDetailPgValues(values) {
  return values.map((/** @type {unknown} */ value) => value instanceof Date ? value.toISOString() : value);
}
