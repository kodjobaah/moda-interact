import pg from "pg";

// Test-only adapter: Prisma models timestamp-without-time-zone values as UTC.
// pg otherwise decodes/encodes these using the host zone. Keep the override local
// to this Client rather than mutating pg's global parser registry.
export const recoveryDetailPgTypes = {
  getTypeParser(oid, format) {
    if (oid === 1114 && format !== "binary") {
      return (value) => new Date(`${value.replace(" ", "T")}Z`);
    }
    return pg.types.getTypeParser(oid, format);
  },
};

// Sending an ISO string avoids pg's host-local Date serializer. The production
// query's ::timestamp cast reads its UTC wall-clock fields, exactly as intended.
export function recoveryDetailPgValues(values) {
  return values.map((value) => value instanceof Date ? value.toISOString() : value);
}
