-- Newtrition V8.5 final core hardening. NON-DESTRUCTIVE.
-- No food rows are deleted or mutated destructively.

ALTER TABLE client ADD COLUMN IF NOT EXISTS organization_id BIGINT REFERENCES organization(id) ON DELETE RESTRICT;
UPDATE client c SET organization_id=cl.organization_id FROM clinician cl WHERE cl.id=c.clinician_id AND c.organization_id IS NULL;

DO $$ BEGIN
  ALTER TABLE client ALTER COLUMN organization_id SET NOT NULL;
EXCEPTION WHEN others THEN
  -- Leave nullable only if legacy data cannot yet satisfy the invariant; trigger still enforces matching.
END $$;

CREATE INDEX IF NOT EXISTS idx_client_org_clinician ON client(organization_id, clinician_id, id DESC);

CREATE OR REPLACE FUNCTION enforce_client_org_match() RETURNS trigger AS $$
DECLARE clinician_org BIGINT;
BEGIN
  SELECT organization_id INTO clinician_org FROM clinician WHERE id=NEW.clinician_id;
  IF NEW.organization_id IS NULL THEN NEW.organization_id=clinician_org; END IF;
  IF clinician_org IS NOT NULL AND NEW.organization_id IS DISTINCT FROM clinician_org THEN
    RAISE EXCEPTION 'CLIENT_ORGANIZATION_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_client_org_match ON client;
CREATE TRIGGER trg_client_org_match BEFORE INSERT OR UPDATE OF clinician_id, organization_id ON client FOR EACH ROW EXECUTE FUNCTION enforce_client_org_match();

-- Workflow cannot skip clinical review/release.
DO $$ BEGIN
  ALTER TABLE plan ADD CONSTRAINT plan_release_requires_approval
    CHECK (NOT is_released OR (workflow_status='APPROVED' AND quality_status='PASS'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION enforce_plan_workflow_transition() RETURNS trigger AS $$
BEGIN
  IF OLD.workflow_status='DRAFT' AND NEW.workflow_status NOT IN ('DRAFT','IN_REVIEW') THEN
    RAISE EXCEPTION 'INVALID_PLAN_TRANSITION_FROM_DRAFT';
  END IF;
  IF OLD.workflow_status='IN_REVIEW' AND NEW.workflow_status NOT IN ('IN_REVIEW','DRAFT','APPROVED') THEN
    RAISE EXCEPTION 'INVALID_PLAN_TRANSITION_FROM_REVIEW';
  END IF;
  IF OLD.workflow_status='APPROVED' AND NEW.workflow_status NOT IN ('APPROVED','SUPERSEDED') THEN
    RAISE EXCEPTION 'INVALID_PLAN_TRANSITION_FROM_APPROVED';
  END IF;
  IF OLD.workflow_status='SUPERSEDED' AND NEW.workflow_status <> 'SUPERSEDED' THEN
    RAISE EXCEPTION 'INVALID_PLAN_TRANSITION_FROM_SUPERSEDED';
  END IF;
  IF NEW.is_released AND NEW.workflow_status <> 'APPROVED' THEN
    RAISE EXCEPTION 'RELEASE_REQUIRES_APPROVED_STATUS';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_plan_workflow_transition ON plan;
CREATE TRIGGER trg_plan_workflow_transition BEFORE UPDATE OF workflow_status,is_released,quality_status ON plan FOR EACH ROW EXECUTE FUNCTION enforce_plan_workflow_transition();

-- Indexes for organization-scoped queries.
CREATE INDEX IF NOT EXISTS idx_plan_client_version ON plan(client_id, version DESC);

-- Preserve food records forever: deactivate rather than delete.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_prevent_food_item_delete') THEN
    RAISE EXCEPTION 'FOOD_DELETE_GUARD_MISSING';
  END IF;
END $$;

-- Dynamic coverage view keeps the catalog auditable without hard-coded counts.
CREATE OR REPLACE VIEW v_food_data_coverage AS
SELECT
  COUNT(*)::int AS total_foods,
  COUNT(*) FILTER (WHERE allergen_profile_status='VERIFIED')::int AS allergen_verified,
  COUNT(*) FILTER (WHERE allergen_profile_status='INFERRED_PENDING_REVIEW')::int AS allergen_pending,
  COUNT(*) FILTER (WHERE allergen_profile_status='UNKNOWN')::int AS allergen_unknown,
  COUNT(*) FILTER (WHERE food_role='UNKNOWN')::int AS food_role_unknown,
  COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM food_ingredient fi WHERE fi.food_item_id=f.id))::int AS foods_with_ingredients,
  COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM portion_option po WHERE po.food_item_id=f.id))::int AS foods_with_portions,
  COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM food_diet_tag dt WHERE dt.food_item_id=f.id))::int AS foods_with_diet_tags
FROM food_item f;
