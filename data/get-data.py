#!/usr/bin/env python3
import argparse
import csv
import sys
import psycopg2
from psycopg2 import sql


def parse_qualified_table(table_arg: str):
    """Splits 'schema.table' or defaults schema to 'public' if omitted."""
    parts = table_arg.split(".")
    if len(parts) == 1:
        return "public", parts[0]
    elif len(parts) == 2:
        return parts[0], parts[1]
    else:
        raise ValueError(
            f"Invalid table identifier '{table_arg}'. Expected format: [schema.]table"
        )


def main():
    parser = argparse.ArgumentParser(
        prog="get-data",
        description="Extract a PostgreSQL table to a CSV file with headers.",
    )
    parser.add_argument("url", help="PostgreSQL connection URL (e.g. postgresql://user:pass@host:5432/dbname)")
    parser.add_argument("table", help="Target table formatted as 'schema.tablename' or 'tablename'")
    args = parser.parse_args()

    try:
        schema_name, table_name = parse_qualified_table(args.table)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    # Derive output filename
    output_filename = f"{table_name}.csv" if schema_name == "public" else f"{schema_name}_{table_name}.csv"

    print(f"Connecting to database and extracting `{schema_name}.{table_name}`...")

    try:
        # Connect using the URL DSN
        with psycopg2.connect(args.url) as conn:
            # Use a named server-side cursor to avoid loading huge tables into RAM all at once
            with conn.cursor(name="stream_export_cursor") as cursor:
                # Safely escape schema and table identifiers against SQL injection
                query = sql.SQL("SELECT * FROM {}.{}").format(
                    sql.Identifier(schema_name),
                    sql.Identifier(table_name),
                )
                cursor.execute(query)

                # Extract column headings
                if not cursor.description:
                    print("Error: Query returned no column metadata.", file=sys.stderr)
                    sys.exit(1)

                headers = [col[0] for col in cursor.description]

                # Write out to CSV in chunks
                row_count = 0
                chunk_size = 2000

                with open(output_filename, mode="w", newline="", encoding="utf-8") as f:
                    writer = csv.writer(f)
                    writer.writerow(headers)

                    while True:
                        rows = cursor.fetchmany(chunk_size)
                        if not rows:
                            break
                        writer.writerows(rows)
                        row_count += len(rows)

        print(f"Success: Exported {row_count} rows to '{output_filename}'.")

    except psycopg2.Error as e:
        print(f"Database error: {e}", file=sys.stderr)
        sys.exit(1)
    except OSError as e:
        print(f"File writing error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()