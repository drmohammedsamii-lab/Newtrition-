#!/usr/bin/env bash
set -euo pipefail
DB="${1:-newtrition}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
createdb "$DB" 2>/dev/null || echo "(database exists, continuing)"
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$HERE/schema.sql"
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$HERE/food_data.sql"
psql -d "$DB" -c "SELECT * FROM v_food_data_coverage;"
echo "Done."
