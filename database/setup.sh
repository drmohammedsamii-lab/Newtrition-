#!/usr/bin/env bash
set -euo pipefail
DB="${1:-newtrition}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
createdb "$DB" 2>/dev/null || echo "(database exists, continuing)"
FILES=(schema.sql)
for f in seed_foods.sql substitution.sql substitution_v3_1.sql schema_auth.sql migrate_v3_7.sql migrate_v3_8_review.sql migrate_v3_9_remediation.sql migrate_v4_0_food_intelligence.sql migrate_v4_1_constraints.sql migrate_v5_0_quality.sql migrate_v5_1_repair.sql migrate_v5_2.sql migrate_v5_4_workflow.sql migrate_v6_7_ai_draft.sql migrate_v7_0_client_portal.sql migrate_v8_0_saas.sql schema_allergen_safety.sql migrate_v8_4_hardening.sql migrate_v8_4_3_integration.sql migrate_v8_5_final_core.sql; do
  if [ -f "$HERE/$f" ]; then psql -d "$DB" -v ON_ERROR_STOP=1 -f "$HERE/$f"; fi
done
psql -d "$DB" -v ON_ERROR_STOP=1 -c "SELECT * FROM v_food_data_coverage; SELECT count(*) AS foods FROM food_item;"
echo "Done. No food rows are deleted by setup/migrations."
