#!/usr/bin/env bash
set -euo pipefail
BASE="/database"
DB="${POSTGRES_DB:-newtrition}"
FILES=(
  schema.sql seed_foods.sql substitution.sql substitution_v3_1.sql schema_auth.sql
  migrate_v3_7.sql migrate_v3_8_review.sql migrate_v3_9_remediation.sql
  migrate_v4_0_food_intelligence.sql migrate_v4_1_constraints.sql
  migrate_v5_0_quality.sql migrate_v5_1_repair.sql migrate_v5_2.sql
  migrate_v5_4_workflow.sql migrate_v6_7_ai_draft.sql migrate_v7_0_client_portal.sql
  migrate_v8_0_saas.sql schema_allergen_safety.sql migrate_v8_4_hardening.sql
  migrate_v8_4_3_integration.sql migrate_v8_5_final_core.sql
)
for f in "${FILES[@]}"; do
  if [ -f "$BASE/$f" ]; then
    echo "[newtrition-db] $f"
    psql -v ON_ERROR_STOP=1 -d "$DB" -f "$BASE/$f"
  fi
done
psql -v ON_ERROR_STOP=1 -d "$DB" -c "SELECT total_foods, allergen_verified, allergen_pending, allergen_unknown, food_role_unknown FROM v_food_data_coverage;"
echo "[newtrition-db] initialization complete; food rows are preserved."
