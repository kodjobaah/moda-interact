// The database-owned seed is a psql script. pg rejects on SQL errors already,
// so remove only its known fail-fast client directive; preserve every SQL byte.
export async function loadRecoveryDetailSeed(client, source) {
  const header = source.match(/^\\set ON_ERROR_STOP on\r?\n/);
  if (!header) throw new Error("Expected recovery seed ON_ERROR_STOP header");
  const sql = source.slice(header[0].length);
  if (/^[\t ]*\\/m.test(sql)) throw new Error("Unsupported psql directive in recovery seed");
  // Deliberately await and propagate driver failures; never continue setup.
  await client.query(sql);
}
