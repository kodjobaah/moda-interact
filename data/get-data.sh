#!/usr/bin/env bash

set -euo pipefail

# Check for required arguments
if [ "$#" -ne 2 ]; then
  echo "Usage: get-data <url-to-postgres> <schema.tablename>" >&2
  exit 1
fi

DB_URL="$1"
TARGET="$2"

# Check if psql is installed
if ! command -v psql &> /dev/null; then
  echo "Error: 'psql' client is not installed or not in PATH." >&2
  exit 1
fi

# Parse schema and table name
if [[ "$TARGET" == *.* ]]; then
  SCHEMA="${TARGET%%.*}"
  TABLE="${TARGET#*.}"
else
  SCHEMA="public"
  TABLE="$TARGET"
fi

# Determine CSV output filename
if [ "$SCHEMA" = "public" ]; then
  OUTPUT_FILE="${TABLE}.csv"
else
  OUTPUT_FILE="${SCHEMA}_${TABLE}.csv"
fi

echo "Exporting '${SCHEMA}.${TABLE}' to '${OUTPUT_FILE}'..."

# Run psql using client-side \copy with CSV and HEADER options
psql "$DB_URL" -v ON_ERROR_STOP=1 --quiet -c \
  "\copy (SELECT * FROM \"${SCHEMA}\".\"${TABLE}\") TO '${OUTPUT_FILE}' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')"

echo "Success: Exported to '${OUTPUT_FILE}'."