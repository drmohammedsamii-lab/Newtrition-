-- V8.4.3 integration hardening. Non-destructive.
ALTER TABLE client ADD COLUMN IF NOT EXISTS organization_id BIGINT REFERENCES organization(id) ON DELETE SET NULL;
UPDATE client c SET organization_id=cl.organization_id FROM clinician cl WHERE cl.id=c.clinician_id AND c.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_client_org ON client(organization_id);
CREATE OR REPLACE FUNCTION enforce_client_org_match() RETURNS trigger AS $$
DECLARE clinician_org BIGINT;
BEGIN
  SELECT organization_id INTO clinician_org FROM clinician WHERE id=NEW.clinician_id;
  IF NEW.organization_id IS NULL THEN NEW.organization_id=clinician_org; END IF;
  IF clinician_org IS NOT NULL AND NEW.organization_id IS DISTINCT FROM clinician_org THEN RAISE EXCEPTION 'CLIENT_ORGANIZATION_MISMATCH'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_client_org_match ON client;
CREATE TRIGGER trg_client_org_match BEFORE INSERT OR UPDATE OF clinician_id, organization_id ON client FOR EACH ROW EXECUTE FUNCTION enforce_client_org_match();
