--
-- PostgreSQL database dump
--

\restrict GUpp8AVd2ep044UKypRFePdnjUY4U4jt7kKjHyiJi6d8KIvnWDQyDBc1wpJiygC

-- Dumped from database version 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: allergen_profile_status; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.allergen_profile_status AS ENUM (
    'UNKNOWN',
    'INFERRED_PENDING_REVIEW',
    'VERIFIED'
);


ALTER TYPE public.allergen_profile_status OWNER TO postgres;

--
-- Name: clinician_role; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.clinician_role AS ENUM (
    'owner',
    'clinician',
    'assistant'
);


ALTER TYPE public.clinician_role OWNER TO postgres;

--
-- Name: entity_type; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.entity_type AS ENUM (
    'FOOD',
    'PRODUCT',
    'MEAL',
    'RECIPE'
);


ALTER TYPE public.entity_type OWNER TO postgres;

--
-- Name: evidence_tier; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.evidence_tier AS ENUM (
    'high',
    'verified',
    'calculated',
    'estimated',
    'unknown'
);


ALTER TYPE public.evidence_tier OWNER TO postgres;

--
-- Name: food_role; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.food_role AS ENUM (
    'PROTEIN',
    'STARCH',
    'DAIRY',
    'FRUIT',
    'VEGETABLE',
    'LEGUME',
    'FAT_NUT',
    'BEVERAGE',
    'SWEET',
    'BAR_SUPP',
    'COMPOSITE_MEAL',
    'UNKNOWN'
);


ALTER TYPE public.food_role OWNER TO postgres;

--
-- Name: nutrition_status; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.nutrition_status AS ENUM (
    'COMPUTABLE',
    'INCOMPLETE',
    'CONFLICT_REVIEW',
    'CORRECTED_PENDING_SIGNOFF'
);


ALTER TYPE public.nutrition_status OWNER TO postgres;

--
-- Name: review_status; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.review_status AS ENUM (
    'PENDING',
    'APPROVED',
    'REJECTED',
    'NEEDS_SOURCE'
);


ALTER TYPE public.review_status OWNER TO postgres;

--
-- Name: enforce_client_organization_match(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.enforce_client_organization_match() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  clinician_org BIGINT;
BEGIN
  SELECT organization_id INTO clinician_org FROM clinician WHERE id = NEW.clinician_id;
  IF NEW.organization_id IS DISTINCT FROM clinician_org THEN
    RAISE EXCEPTION 'CLIENT_ORGANIZATION_MISMATCH: client.organization_id must match clinician.organization_id'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.enforce_client_organization_match() OWNER TO postgres;

--
-- Name: enforce_plan_workflow_transition(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.enforce_plan_workflow_transition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.workflow_status IS DISTINCT FROM OLD.workflow_status THEN
    IF NOT (
      (OLD.workflow_status = 'DRAFT'      AND NEW.workflow_status = 'IN_REVIEW') OR
      (OLD.workflow_status = 'IN_REVIEW'  AND NEW.workflow_status IN ('APPROVED','DRAFT')) OR
      (OLD.workflow_status = 'APPROVED'   AND NEW.workflow_status IN ('SUPERSEDED','IN_REVIEW'))
    ) THEN
      RAISE EXCEPTION 'illegal plan workflow transition: % -> %', OLD.workflow_status, NEW.workflow_status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.enforce_plan_workflow_transition() OWNER TO postgres;

--
-- Name: find_substitutes(text, integer); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.find_substitutes(p_canonical text, p_limit integer DEFAULT 12) RETURNS TABLE(canonical_id text, name_ar text, name_en text, food_role public.food_role, kcal numeric, protein_g numeric, evidence_tier public.evidence_tier, distance numeric)
    LANGUAGE sql STABLE
    AS $$
  WITH t AS (
    SELECT f.id, f.food_role, f.category, s.kcal, s.protein_g
    FROM food_item f
    JOIN nutrition_serving s ON s.food_item_id = f.id
    WHERE f.canonical_id = p_canonical
  )
  SELECT c.canonical_id, c.name_ar, c.name_en, c.food_role,
         c.kcal, c.protein_g, c.evidence_tier,
         ROUND(
             abs(c.kcal - t.kcal) / GREATEST(t.kcal, 1) * 100
           + abs(COALESCE(c.protein_g,0) - COALESCE(t.protein_g,0))
             / GREATEST(COALESCE(t.protein_g,0), 1) * 60
           + CASE WHEN c.category = t.category THEN 0 ELSE 12 END
           + CASE c.evidence_tier
               WHEN 'high' THEN 0 WHEN 'verified' THEN 3
               WHEN 'calculated' THEN 10 ELSE 18 END
         , 1) AS distance
  FROM v_optimizer_eligible c
  CROSS JOIN t
  WHERE c.id <> t.id
    AND c.food_role = t.food_role                              -- hard constraint
    AND c.kcal BETWEEN t.kcal * 0.70 AND t.kcal * 1.30         -- energy corridor
    AND (t.protein_g IS NULL OR c.protein_g IS NULL
         OR c.protein_g >= t.protein_g * 0.70)                 -- never downgrade protein
  ORDER BY distance ASC
  LIMIT p_limit;
$$;


ALTER FUNCTION public.find_substitutes(p_canonical text, p_limit integer) OWNER TO postgres;

--
-- Name: plan_release_requires_approval(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.plan_release_requires_approval() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.is_released AND NOT OLD.is_released AND NEW.workflow_status <> 'APPROVED' THEN
    RAISE EXCEPTION 'plan cannot be released unless workflow_status = APPROVED (was %)', NEW.workflow_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.plan_release_requires_approval() OWNER TO postgres;

--
-- Name: prevent_food_item_delete(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.prevent_food_item_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'food_item rows cannot be deleted (id=%). Use is_active=false or a status column instead.', OLD.id
    USING ERRCODE = 'restrict_violation';
  RETURN NULL;
END;
$$;


ALTER FUNCTION public.prevent_food_item_delete() OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.audit_log (
    id bigint NOT NULL,
    clinician_id bigint,
    action text NOT NULL,
    target text,
    detail text,
    ip text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.audit_log OWNER TO postgres;

--
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.audit_log_id_seq OWNER TO postgres;

--
-- Name: audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.audit_log_id_seq OWNED BY public.audit_log.id;


--
-- Name: client; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.client (
    id bigint NOT NULL,
    clinician_id bigint NOT NULL,
    full_name text NOT NULL,
    gender text,
    birth_year integer,
    height_cm numeric(5,1),
    goal text,
    conditions text,
    medications text,
    gi_notes text,
    habits text,
    sleep text,
    stress text,
    ramadan_mode boolean DEFAULT false,
    carb_cycling boolean DEFAULT false,
    diet_pattern text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    organization_id bigint
);


ALTER TABLE public.client OWNER TO postgres;

--
-- Name: client_account; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.client_account (
    id bigint NOT NULL,
    client_id bigint NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    must_change_password boolean DEFAULT true NOT NULL,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.client_account OWNER TO postgres;

--
-- Name: client_account_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.client_account_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.client_account_id_seq OWNER TO postgres;

--
-- Name: client_account_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.client_account_id_seq OWNED BY public.client_account.id;


--
-- Name: client_constraint; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.client_constraint (
    id bigint NOT NULL,
    client_id bigint NOT NULL,
    kind text NOT NULL,
    constraint_key text NOT NULL,
    value text NOT NULL,
    severity text DEFAULT 'HARD'::text NOT NULL,
    source text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT client_constraint_kind_check CHECK ((kind = ANY (ARRAY['diet'::text, 'allergen'::text, 'medical'::text, 'cultural'::text, 'meal'::text, 'macro'::text, 'preference'::text]))),
    CONSTRAINT client_constraint_severity_check CHECK ((severity = ANY (ARRAY['HARD'::text, 'SOFT'::text, 'INFO'::text]))),
    CONSTRAINT client_constraint_value_check CHECK ((length(btrim(value)) > 0))
);


ALTER TABLE public.client_constraint OWNER TO postgres;

--
-- Name: client_constraint_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.client_constraint_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.client_constraint_id_seq OWNER TO postgres;

--
-- Name: client_constraint_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.client_constraint_id_seq OWNED BY public.client_constraint.id;


--
-- Name: client_exclusion; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.client_exclusion (
    id bigint NOT NULL,
    client_id bigint NOT NULL,
    term text NOT NULL
);


ALTER TABLE public.client_exclusion OWNER TO postgres;

--
-- Name: client_exclusion_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.client_exclusion_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.client_exclusion_id_seq OWNER TO postgres;

--
-- Name: client_exclusion_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.client_exclusion_id_seq OWNED BY public.client_exclusion.id;


--
-- Name: client_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.client_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.client_id_seq OWNER TO postgres;

--
-- Name: client_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.client_id_seq OWNED BY public.client.id;


--
-- Name: client_session; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.client_session (
    id bigint NOT NULL,
    client_account_id bigint NOT NULL,
    client_id bigint NOT NULL,
    token_hash text NOT NULL,
    user_agent text,
    ip text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone
);


ALTER TABLE public.client_session OWNER TO postgres;

--
-- Name: client_session_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.client_session_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.client_session_id_seq OWNER TO postgres;

--
-- Name: client_session_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.client_session_id_seq OWNED BY public.client_session.id;


--
-- Name: clinician; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.clinician (
    id bigint NOT NULL,
    email text NOT NULL,
    full_name text NOT NULL,
    password_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    role public.clinician_role DEFAULT 'clinician'::public.clinician_role NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    last_login_at timestamp with time zone,
    organization_id bigint
);


ALTER TABLE public.clinician OWNER TO postgres;

--
-- Name: clinician_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.clinician_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.clinician_id_seq OWNER TO postgres;

--
-- Name: clinician_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.clinician_id_seq OWNED BY public.clinician.id;


--
-- Name: daily_log; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.daily_log (
    id bigint NOT NULL,
    client_id bigint NOT NULL,
    log_date date NOT NULL,
    weight_kg numeric(5,2),
    water_ml integer,
    steps integer,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT daily_log_steps_check CHECK (((steps IS NULL) OR ((steps >= 0) AND (steps <= 100000)))),
    CONSTRAINT daily_log_water_ml_check CHECK (((water_ml IS NULL) OR ((water_ml >= 0) AND (water_ml <= 10000)))),
    CONSTRAINT daily_log_weight_kg_check CHECK (((weight_kg IS NULL) OR ((weight_kg >= (20)::numeric) AND (weight_kg <= (400)::numeric))))
);


ALTER TABLE public.daily_log OWNER TO postgres;

--
-- Name: daily_log_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.daily_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.daily_log_id_seq OWNER TO postgres;

--
-- Name: daily_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.daily_log_id_seq OWNED BY public.daily_log.id;


--
-- Name: evidence; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.evidence (
    food_item_id bigint NOT NULL,
    tier public.evidence_tier DEFAULT 'unknown'::public.evidence_tier NOT NULL,
    confidence text,
    source_ref text,
    verified_by text,
    verified_at timestamp with time zone,
    id bigint NOT NULL
);


ALTER TABLE public.evidence OWNER TO postgres;

--
-- Name: evidence_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.evidence_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.evidence_id_seq OWNER TO postgres;

--
-- Name: evidence_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.evidence_id_seq OWNED BY public.evidence.id;


--
-- Name: followup; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.followup (
    id bigint NOT NULL,
    client_id bigint NOT NULL,
    visit_date date NOT NULL,
    weight_kg numeric(5,2),
    waist_cm numeric(5,1),
    body_fat_pct numeric(4,1),
    adherence_pct numeric(5,2),
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.followup OWNER TO postgres;

--
-- Name: followup_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.followup_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.followup_id_seq OWNER TO postgres;

--
-- Name: followup_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.followup_id_seq OWNED BY public.followup.id;


--
-- Name: food_allergen; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.food_allergen (
    food_item_id bigint NOT NULL,
    allergen text NOT NULL,
    source_ref text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    confidence text DEFAULT 'inferred'::text,
    CONSTRAINT food_allergen_confidence_chk CHECK ((confidence = ANY (ARRAY['explicit_label'::text, 'name_keyword'::text, 'inferred_pattern'::text, 'clinician_added'::text])))
);


ALTER TABLE public.food_allergen OWNER TO postgres;

--
-- Name: food_diet_tag; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.food_diet_tag (
    food_item_id bigint NOT NULL,
    tag text NOT NULL,
    source_ref text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.food_diet_tag OWNER TO postgres;

--
-- Name: food_ingredient; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.food_ingredient (
    food_item_id bigint NOT NULL,
    ingredient_name text NOT NULL,
    is_major boolean DEFAULT true NOT NULL,
    source_ref text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.food_ingredient OWNER TO postgres;

--
-- Name: food_item; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.food_item (
    id bigint NOT NULL,
    canonical_id text NOT NULL,
    source_id text,
    name_ar text NOT NULL,
    name_en text,
    entity_type public.entity_type NOT NULL,
    food_role public.food_role DEFAULT 'UNKNOWN'::public.food_role NOT NULL,
    category text,
    source text,
    brand text,
    portion_label text,
    portion_grams numeric(8,2),
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    allergen_profile_status public.allergen_profile_status DEFAULT 'UNKNOWN'::public.allergen_profile_status NOT NULL,
    allergen_profile_reviewed_by text,
    allergen_profile_reviewed_at timestamp with time zone
);


ALTER TABLE public.food_item OWNER TO postgres;

--
-- Name: food_item_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.food_item_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.food_item_id_seq OWNER TO postgres;

--
-- Name: food_item_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.food_item_id_seq OWNED BY public.food_item.id;


--
-- Name: login_attempt; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.login_attempt (
    id bigint NOT NULL,
    email text NOT NULL,
    ip text,
    successful boolean NOT NULL,
    attempted_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.login_attempt OWNER TO postgres;

--
-- Name: login_attempt_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.login_attempt_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.login_attempt_id_seq OWNER TO postgres;

--
-- Name: login_attempt_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.login_attempt_id_seq OWNED BY public.login_attempt.id;


--
-- Name: meal_checkin; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.meal_checkin (
    id bigint NOT NULL,
    client_id bigint NOT NULL,
    plan_item_id bigint NOT NULL,
    log_date date NOT NULL,
    eaten boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.meal_checkin OWNER TO postgres;

--
-- Name: meal_checkin_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.meal_checkin_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.meal_checkin_id_seq OWNER TO postgres;

--
-- Name: meal_checkin_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.meal_checkin_id_seq OWNED BY public.meal_checkin.id;


--
-- Name: nutrition_original; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.nutrition_original (
    food_item_id bigint NOT NULL,
    kcal numeric(8,2),
    protein_g numeric(7,2),
    carb_g numeric(7,2),
    fat_g numeric(7,2),
    correction_rule text,
    rationale text,
    corrected_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.nutrition_original OWNER TO postgres;

--
-- Name: nutrition_per100; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.nutrition_per100 (
    food_item_id bigint NOT NULL,
    kcal numeric(8,2),
    protein_g numeric(7,2),
    carb_g numeric(7,2),
    fat_g numeric(7,2),
    fiber_g numeric(7,2)
);


ALTER TABLE public.nutrition_per100 OWNER TO postgres;

--
-- Name: nutrition_serving; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.nutrition_serving (
    food_item_id bigint NOT NULL,
    kcal numeric(8,2),
    protein_g numeric(7,2),
    carb_g numeric(7,2),
    fat_g numeric(7,2),
    fiber_g numeric(7,2),
    status public.nutrition_status DEFAULT 'COMPUTABLE'::public.nutrition_status NOT NULL,
    kcal_from_macros numeric(8,2) GENERATED ALWAYS AS ((((COALESCE(protein_g, (0)::numeric) * (4)::numeric) + (COALESCE(carb_g, (0)::numeric) * (4)::numeric)) + (COALESCE(fat_g, (0)::numeric) * (9)::numeric))) STORED,
    CONSTRAINT nonneg_serving CHECK (((COALESCE(kcal, (0)::numeric) >= (0)::numeric) AND (COALESCE(protein_g, (0)::numeric) >= (0)::numeric) AND (COALESCE(carb_g, (0)::numeric) >= (0)::numeric) AND (COALESCE(fat_g, (0)::numeric) >= (0)::numeric) AND (COALESCE(fiber_g, (0)::numeric) >= (0)::numeric)))
);


ALTER TABLE public.nutrition_serving OWNER TO postgres;

--
-- Name: organization; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.organization (
    id bigint NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.organization OWNER TO postgres;

--
-- Name: organization_entitlement; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.organization_entitlement (
    organization_id bigint NOT NULL,
    feature_code text NOT NULL,
    limit_value bigint,
    enabled boolean DEFAULT true NOT NULL
);


ALTER TABLE public.organization_entitlement OWNER TO postgres;

--
-- Name: organization_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.organization_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.organization_id_seq OWNER TO postgres;

--
-- Name: organization_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.organization_id_seq OWNED BY public.organization.id;


--
-- Name: plan; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.plan (
    id bigint NOT NULL,
    client_id bigint NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    label text,
    target_kcal numeric(8,2),
    target_protein_g numeric(7,2),
    target_carb_g numeric(7,2),
    target_fat_g numeric(7,2),
    target_fiber_g numeric(7,2),
    approved_by text,
    approved_at timestamp with time zone,
    is_released boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    notes text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    superseded_by bigint,
    workflow_status text DEFAULT 'DRAFT'::text NOT NULL,
    submitted_by text,
    submitted_at timestamp with time zone,
    reviewed_by text,
    reviewed_at timestamp with time zone,
    quality_score numeric(5,1),
    quality_status text,
    quality_blockers jsonb DEFAULT '[]'::jsonb NOT NULL,
    quality_warnings jsonb DEFAULT '[]'::jsonb NOT NULL,
    optimizer_version text,
    repair_status text,
    repair_attempts jsonb DEFAULT '[]'::jsonb NOT NULL,
    repair_summary jsonb,
    explainability jsonb,
    repair_scope text,
    repair_day_index integer,
    repair_slot text,
    ai_intent jsonb,
    CONSTRAINT plan_workflow_status_chk CHECK ((workflow_status = ANY (ARRAY['DRAFT'::text, 'IN_REVIEW'::text, 'APPROVED'::text, 'SUPERSEDED'::text])))
);


ALTER TABLE public.plan OWNER TO postgres;

--
-- Name: plan_day; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.plan_day (
    id bigint NOT NULL,
    plan_id bigint NOT NULL,
    day_index integer NOT NULL,
    day_name text,
    day_type text,
    CONSTRAINT plan_day_day_index_check CHECK (((day_index >= 0) AND (day_index <= 6)))
);


ALTER TABLE public.plan_day OWNER TO postgres;

--
-- Name: plan_day_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.plan_day_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.plan_day_id_seq OWNER TO postgres;

--
-- Name: plan_day_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.plan_day_id_seq OWNED BY public.plan_day.id;


--
-- Name: plan_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.plan_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.plan_id_seq OWNER TO postgres;

--
-- Name: plan_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.plan_id_seq OWNED BY public.plan.id;


--
-- Name: plan_item; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.plan_item (
    id bigint NOT NULL,
    plan_day_id bigint NOT NULL,
    food_item_id bigint,
    slot text NOT NULL,
    qty numeric(6,2) DEFAULT 1 NOT NULL,
    is_locked boolean DEFAULT false NOT NULL,
    custom_name text,
    custom_kcal numeric(8,2),
    substituted_from bigint,
    substitution_method text,
    "position" integer DEFAULT 0 NOT NULL,
    custom_protein_g numeric(7,2),
    custom_carb_g numeric(7,2),
    custom_fat_g numeric(7,2),
    custom_fiber_g numeric(7,2),
    CONSTRAINT plan_item_has_content CHECK (((food_item_id IS NOT NULL) OR (custom_name IS NOT NULL))),
    CONSTRAINT plan_item_qty_check CHECK ((qty > (0)::numeric))
);


ALTER TABLE public.plan_item OWNER TO postgres;

--
-- Name: plan_item_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.plan_item_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.plan_item_id_seq OWNER TO postgres;

--
-- Name: plan_item_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.plan_item_id_seq OWNED BY public.plan_item.id;


--
-- Name: plan_repair_event; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.plan_repair_event (
    id bigint NOT NULL,
    plan_id bigint,
    clinician_id bigint,
    scope text NOT NULL,
    day_index integer,
    slot text,
    before_score numeric,
    after_score numeric,
    improved boolean DEFAULT false NOT NULL,
    detail jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.plan_repair_event OWNER TO postgres;

--
-- Name: plan_repair_event_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.plan_repair_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.plan_repair_event_id_seq OWNER TO postgres;

--
-- Name: plan_repair_event_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.plan_repair_event_id_seq OWNED BY public.plan_repair_event.id;


--
-- Name: portion_option; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.portion_option (
    id bigint NOT NULL,
    food_item_id bigint NOT NULL,
    label text NOT NULL,
    grams numeric(8,2),
    ml numeric(8,2),
    unit_count numeric(8,2),
    is_default boolean DEFAULT false NOT NULL,
    source_ref text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT portion_option_check CHECK ((((((grams IS NOT NULL))::integer + ((ml IS NOT NULL))::integer) + ((unit_count IS NOT NULL))::integer) >= 1)),
    CONSTRAINT portion_option_grams_check CHECK (((grams IS NULL) OR (grams > (0)::numeric))),
    CONSTRAINT portion_option_ml_check CHECK (((ml IS NULL) OR (ml > (0)::numeric))),
    CONSTRAINT portion_option_unit_count_check CHECK (((unit_count IS NULL) OR (unit_count > (0)::numeric)))
);


ALTER TABLE public.portion_option OWNER TO postgres;

--
-- Name: portion_option_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.portion_option_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.portion_option_id_seq OWNER TO postgres;

--
-- Name: portion_option_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.portion_option_id_seq OWNED BY public.portion_option.id;


--
-- Name: review_queue; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.review_queue (
    id bigint NOT NULL,
    food_item_id bigint NOT NULL,
    reason text NOT NULL,
    detail text,
    status public.review_status DEFAULT 'PENDING'::public.review_status NOT NULL,
    resolved_by text,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.review_queue OWNER TO postgres;

--
-- Name: review_queue_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.review_queue_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.review_queue_id_seq OWNER TO postgres;

--
-- Name: review_queue_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.review_queue_id_seq OWNED BY public.review_queue.id;


--
-- Name: session; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.session (
    id bigint NOT NULL,
    clinician_id bigint,
    token_hash text NOT NULL,
    user_agent text,
    ip text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    client_account_id bigint,
    CONSTRAINT session_exactly_one_subject CHECK ((num_nonnulls(clinician_id, client_account_id) = 1))
);


ALTER TABLE public.session OWNER TO postgres;

--
-- Name: session_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.session_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.session_id_seq OWNER TO postgres;

--
-- Name: session_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.session_id_seq OWNED BY public.session.id;


--
-- Name: subscription; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.subscription (
    id bigint NOT NULL,
    organization_id bigint NOT NULL,
    plan_code text NOT NULL,
    status text DEFAULT 'TRIAL'::text NOT NULL,
    current_period_end timestamp with time zone,
    provider_customer_id text,
    provider_subscription_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscription_status_check CHECK ((status = ANY (ARRAY['TRIAL'::text, 'ACTIVE'::text, 'PAST_DUE'::text, 'CANCELED'::text, 'PAUSED'::text])))
);


ALTER TABLE public.subscription OWNER TO postgres;

--
-- Name: subscription_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.subscription_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.subscription_id_seq OWNER TO postgres;

--
-- Name: subscription_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.subscription_id_seq OWNED BY public.subscription.id;


--
-- Name: v_adherence; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.v_adherence AS
 SELECT client_id,
    log_date,
    count(*) FILTER (WHERE eaten) AS eaten,
    count(*) AS logged
   FROM public.meal_checkin mc
  GROUP BY client_id, log_date;


ALTER VIEW public.v_adherence OWNER TO postgres;

--
-- Name: v_client_visible_plan; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.v_client_visible_plan AS
 SELECT id AS plan_id,
    client_id,
    version,
    label,
    target_kcal,
    target_protein_g,
    target_carb_g,
    target_fat_g,
    target_fiber_g,
    approved_by,
    approved_at,
    notes
   FROM public.plan p
  WHERE (is_released AND (approved_at IS NOT NULL) AND (superseded_by IS NULL));


ALTER VIEW public.v_client_visible_plan OWNER TO postgres;

--
-- Name: v_followup_signals; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.v_followup_signals AS
 WITH ranked AS (
         SELECT f.id,
            f.client_id,
            f.visit_date,
            f.weight_kg,
            f.waist_cm,
            f.body_fat_pct,
            f.adherence_pct,
            f.notes,
            f.created_at,
            c.clinician_id,
            row_number() OVER (PARTITION BY f.client_id ORDER BY f.visit_date DESC) AS rn,
            lag(f.weight_kg) OVER (PARTITION BY f.client_id ORDER BY f.visit_date) AS prev_weight,
            lag(f.visit_date) OVER (PARTITION BY f.client_id ORDER BY f.visit_date) AS prev_date
           FROM (public.followup f
             JOIN public.client c ON ((c.id = f.client_id)))
        ), latest AS (
         SELECT ranked.id,
            ranked.client_id,
            ranked.visit_date,
            ranked.weight_kg,
            ranked.waist_cm,
            ranked.body_fat_pct,
            ranked.adherence_pct,
            ranked.notes,
            ranked.created_at,
            ranked.clinician_id,
            ranked.rn,
            ranked.prev_weight,
            ranked.prev_date
           FROM ranked
          WHERE (ranked.rn = 1)
        )
 SELECT client_id,
    clinician_id,
    visit_date AS last_visit_date,
    (CURRENT_DATE - visit_date) AS days_since_followup,
        CASE
            WHEN ((CURRENT_DATE - visit_date) > 21) THEN 'FOLLOWUP_OVERDUE'::text
            WHEN ((CURRENT_DATE - visit_date) > 13) THEN 'FOLLOWUP_DUE'::text
            ELSE NULL::text
        END AS followup_signal,
        CASE
            WHEN ((adherence_pct IS NOT NULL) AND (adherence_pct < (60)::numeric)) THEN 'LOW_RECENT_ADHERENCE'::text
            ELSE NULL::text
        END AS adherence_signal,
        CASE
            WHEN ((prev_weight IS NOT NULL) AND (prev_date IS NOT NULL) AND (abs((weight_kg - prev_weight)) < 0.3) AND ((visit_date - prev_date) >= 14)) THEN 'WEIGHT_FLAT'::text
            ELSE NULL::text
        END AS weight_signal
   FROM latest l;


ALTER VIEW public.v_followup_signals OWNER TO postgres;

--
-- Name: v_food_candidate_intelligence; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.v_food_candidate_intelligence AS
 SELECT f.id,
    f.canonical_id,
    f.name_ar,
    f.name_en,
    f.category,
    f.entity_type,
    f.food_role,
    f.source,
    f.brand,
    f.portion_label,
    f.portion_grams,
    s.kcal,
    s.protein_g,
    s.carb_g,
    s.fat_g,
    s.fiber_g,
    s.status,
    e.tier AS evidence_tier,
    COALESCE(( SELECT array_agg(fa.allergen ORDER BY fa.allergen) AS array_agg
           FROM public.food_allergen fa
          WHERE (fa.food_item_id = f.id)), ARRAY[]::text[]) AS allergens,
    COALESCE(( SELECT array_agg(fi.ingredient_name ORDER BY fi.ingredient_name) AS array_agg
           FROM public.food_ingredient fi
          WHERE (fi.food_item_id = f.id)), ARRAY[]::text[]) AS ingredients,
    COALESCE(( SELECT array_agg(po.label ORDER BY po.is_default DESC, po.id) AS array_agg
           FROM public.portion_option po
          WHERE (po.food_item_id = f.id)), ARRAY[]::text[]) AS portion_options,
    COALESCE(( SELECT array_agg(dt.tag ORDER BY dt.tag) AS array_agg
           FROM public.food_diet_tag dt
          WHERE (dt.food_item_id = f.id)), ARRAY[]::text[]) AS diet_tags,
    f.allergen_profile_status
   FROM ((public.food_item f
     JOIN public.nutrition_serving s ON ((s.food_item_id = f.id)))
     LEFT JOIN public.evidence e ON ((e.food_item_id = f.id)))
  WHERE f.is_active;


ALTER VIEW public.v_food_candidate_intelligence OWNER TO postgres;

--
-- Name: v_food_data_coverage; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.v_food_data_coverage AS
 SELECT (count(*))::integer AS total_foods,
    (count(*) FILTER (WHERE (allergen_profile_status = 'VERIFIED'::public.allergen_profile_status)))::integer AS allergen_verified,
    (count(*) FILTER (WHERE (allergen_profile_status = 'INFERRED_PENDING_REVIEW'::public.allergen_profile_status)))::integer AS allergen_pending,
    (count(*) FILTER (WHERE (allergen_profile_status = 'UNKNOWN'::public.allergen_profile_status)))::integer AS allergen_unknown,
    (count(*) FILTER (WHERE (food_role = 'UNKNOWN'::public.food_role)))::integer AS food_role_unknown
   FROM public.food_item;


ALTER VIEW public.v_food_data_coverage OWNER TO postgres;

--
-- Name: v_food_intelligence; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.v_food_intelligence AS
 SELECT f.id,
    f.canonical_id,
    f.name_ar,
    f.name_en,
    f.entity_type,
    f.food_role,
    f.category,
    f.source,
    f.brand,
    f.portion_label,
    f.portion_grams,
    f.is_active,
    s.kcal,
    s.protein_g,
    s.carb_g,
    s.fat_g,
    s.fiber_g,
    s.status,
    e.tier AS evidence_tier,
    e.confidence,
    e.source_ref,
    e.verified_by,
    e.verified_at,
    ( SELECT (count(*))::integer AS count
           FROM public.food_ingredient fi
          WHERE (fi.food_item_id = f.id)) AS ingredient_count,
    ( SELECT (count(*))::integer AS count
           FROM public.food_allergen fa
          WHERE (fa.food_item_id = f.id)) AS allergen_count,
    ( SELECT (count(*))::integer AS count
           FROM public.portion_option po
          WHERE (po.food_item_id = f.id)) AS portion_option_count,
        CASE
            WHEN ((f.portion_grams IS NOT NULL) OR (EXISTS ( SELECT 1
               FROM public.portion_option po
              WHERE (po.food_item_id = f.id)))) THEN 'COVERED'::text
            ELSE 'MISSING'::text
        END AS portion_coverage,
        CASE
            WHEN (EXISTS ( SELECT 1
               FROM public.food_ingredient fi
              WHERE (fi.food_item_id = f.id))) THEN 'STRUCTURED'::text
            ELSE 'UNSTRUCTURED'::text
        END AS ingredient_coverage,
        CASE
            WHEN (EXISTS ( SELECT 1
               FROM public.food_allergen fa
              WHERE (fa.food_item_id = f.id))) THEN 'STRUCTURED'::text
            ELSE 'UNKNOWN'::text
        END AS allergen_coverage
   FROM ((public.food_item f
     LEFT JOIN public.nutrition_serving s ON ((s.food_item_id = f.id)))
     LEFT JOIN public.evidence e ON ((e.food_item_id = f.id)));


ALTER VIEW public.v_food_intelligence OWNER TO postgres;

--
-- Name: v_food_quality; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.v_food_quality AS
 SELECT f.id,
    f.canonical_id,
    f.name_ar,
    f.name_en,
    f.category,
    f.entity_type,
    f.food_role,
    f.source,
    f.brand,
    f.portion_label,
    f.portion_grams,
    f.is_active,
    s.kcal,
    s.protein_g,
    s.carb_g,
    s.fat_g,
    s.fiber_g,
    s.status,
    e.tier AS evidence_tier,
        CASE
            WHEN (NOT f.is_active) THEN 'BLOCKED'::text
            WHEN ((s.status <> 'COMPUTABLE'::public.nutrition_status) OR (s.kcal IS NULL) OR (s.protein_g IS NULL) OR (s.carb_g IS NULL) OR (s.fat_g IS NULL)) THEN 'REVIEW_REQUIRED'::text
            WHEN (COALESCE((e.tier)::text, 'unknown'::text) = ANY (ARRAY['estimated'::text, 'unknown'::text])) THEN 'REVIEW_REQUIRED'::text
            WHEN ((s.fiber_g IS NULL) OR (e.tier = 'calculated'::public.evidence_tier)) THEN 'AUTO_WITH_WARNING'::text
            ELSE 'AUTO_ELIGIBLE'::text
        END AS quality_class,
        CASE
            WHEN (NOT f.is_active) THEN ARRAY['inactive'::text]
            ELSE array_remove(ARRAY[
            CASE
                WHEN (s.status <> 'COMPUTABLE'::public.nutrition_status) THEN ('status:'::text || (s.status)::text)
                ELSE NULL::text
            END,
            CASE
                WHEN ((s.kcal IS NULL) OR (s.protein_g IS NULL) OR (s.carb_g IS NULL) OR (s.fat_g IS NULL)) THEN 'missing_core_macros'::text
                ELSE NULL::text
            END,
            CASE
                WHEN (COALESCE((e.tier)::text, 'unknown'::text) = ANY (ARRAY['estimated'::text, 'unknown'::text])) THEN ('evidence:'::text || COALESCE((e.tier)::text, 'missing'::text))
                ELSE NULL::text
            END,
            CASE
                WHEN (s.fiber_g IS NULL) THEN 'missing_fiber'::text
                ELSE NULL::text
            END,
            CASE
                WHEN (e.tier = 'calculated'::public.evidence_tier) THEN 'evidence:calculated'::text
                ELSE NULL::text
            END], NULL::text)
        END AS quality_reasons,
    f.allergen_profile_status
   FROM ((public.food_item f
     LEFT JOIN public.nutrition_serving s ON ((s.food_item_id = f.id)))
     LEFT JOIN public.evidence e ON ((e.food_item_id = f.id)));


ALTER VIEW public.v_food_quality OWNER TO postgres;

--
-- Name: v_optimizer_eligible; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.v_optimizer_eligible AS
 SELECT f.id,
    f.canonical_id,
    f.name_ar,
    f.name_en,
    f.category,
    f.entity_type,
    f.food_role,
    s.kcal,
    s.protein_g,
    s.carb_g,
    s.fat_g,
    s.fiber_g,
    e.tier AS evidence_tier,
    s.status
   FROM ((public.food_item f
     JOIN public.nutrition_serving s ON ((s.food_item_id = f.id)))
     LEFT JOIN public.evidence e ON ((e.food_item_id = f.id)))
  WHERE (f.is_active AND (s.kcal IS NOT NULL) AND (s.status <> ALL (ARRAY['CONFLICT_REVIEW'::public.nutrition_status, 'CORRECTED_PENDING_SIGNOFF'::public.nutrition_status])));


ALTER VIEW public.v_optimizer_eligible OWNER TO postgres;

--
-- Name: v_optimizer_eligible_strict; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.v_optimizer_eligible_strict AS
 SELECT id,
    canonical_id,
    name_ar,
    name_en,
    category,
    entity_type,
    food_role,
    source,
    brand,
    portion_label,
    portion_grams,
    is_active,
    kcal,
    protein_g,
    carb_g,
    fat_g,
    fiber_g,
    status,
    evidence_tier,
    quality_class,
    quality_reasons,
    allergen_profile_status
   FROM public.v_food_quality
  WHERE (quality_class = 'AUTO_ELIGIBLE'::text);


ALTER VIEW public.v_optimizer_eligible_strict OWNER TO postgres;

--
-- Name: v_optimizer_eligible_with_warning; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.v_optimizer_eligible_with_warning AS
 SELECT id,
    canonical_id,
    name_ar,
    name_en,
    category,
    entity_type,
    food_role,
    source,
    brand,
    portion_label,
    portion_grams,
    is_active,
    kcal,
    protein_g,
    carb_g,
    fat_g,
    fiber_g,
    status,
    evidence_tier,
    quality_class,
    quality_reasons,
    allergen_profile_status
   FROM public.v_food_quality
  WHERE (quality_class = ANY (ARRAY['AUTO_ELIGIBLE'::text, 'AUTO_WITH_WARNING'::text]));


ALTER VIEW public.v_optimizer_eligible_with_warning OWNER TO postgres;

--
-- Name: v_plan_owner; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.v_plan_owner AS
 SELECT p.id AS plan_id,
    c.clinician_id,
    c.id AS client_id
   FROM (public.plan p
     JOIN public.client c ON ((c.id = p.client_id)));


ALTER VIEW public.v_plan_owner OWNER TO postgres;

--
-- Name: v_plan_progress; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.v_plan_progress AS
SELECT
    NULL::bigint AS plan_id,
    NULL::bigint AS client_id,
    NULL::integer AS version,
    NULL::timestamp with time zone AS approved_at,
    NULL::text AS quality_status,
    NULL::bigint AS followups_since_approval,
    NULL::numeric AS avg_adherence_since_approval,
    NULL::numeric AS min_weight_since_approval,
    NULL::numeric AS max_weight_since_approval,
    NULL::text AS progress_signal;


ALTER VIEW public.v_plan_progress OWNER TO postgres;

--
-- Name: audit_log id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.audit_log ALTER COLUMN id SET DEFAULT nextval('public.audit_log_id_seq'::regclass);


--
-- Name: client id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.client ALTER COLUMN id SET DEFAULT nextval('public.client_id_seq'::regclass);


--
-- Name: client_account id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.client_account ALTER COLUMN id SET DEFAULT nextval('public.client_account_id_seq'::regclass);


--
-- Name: client_constraint id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.client_constraint ALTER COLUMN id SET DEFAULT nextval('public.client_constraint_id_seq'::regclass);


--
-- Name: client_exclusion id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.client_exclusion ALTER COLUMN id SET DEFAULT nextval('public.client_exclusion_id_seq'::regclass);


--
-- Name: client_session id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.client_session ALTER COLUMN id SET DEFAULT nextval('public.client_session_id_seq'::regclass);


--
-- Name: clinician id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.clinician ALTER COLUMN id SET DEFAULT nextval('public.clinician_id_seq'::regclass);


--
-- Name: daily_log id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.daily_log ALTER COLUMN id SET DEFAULT nextval('public.daily_log_id_seq'::regclass);


--
-- Name: evidence id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.evidence ALTER COLUMN id SET DEFAULT nextval('public.evidence_id_seq'::regclass);


--
-- Name: followup id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.followup ALTER COLUMN id SET DEFAULT nextval('public.followup_id_seq'::regclass);


--
-- Name: food_item id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.food_item ALTER COLUMN id SET DEFAULT nextval('public.food_item_id_seq'::regclass);


--
-- Name: login_attempt id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.login_attempt ALTER COLUMN id SET DEFAULT nextval('public.login_attempt_id_seq'::regclass);


--
-- Name: meal_checkin id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.meal_checkin ALTER COLUMN id SET DEFAULT nextval('public.meal_checkin_id_seq'::regclass);


--
-- Name: organization id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.organization ALTER COLUMN id SET DEFAULT nextval('public.organization_id_seq'::regclass);


--
-- Name: plan id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plan ALTER COLUMN id SET DEFAULT nextval('public.plan_id_seq'::regclass);


--
-- Name: plan_day id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plan_day ALTER COLUMN id SET DEFAULT nextval('public.plan_day_id_seq'::regclass);


--
-- Name: plan_item id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plan_item ALTER COLUMN id SET DEFAULT nextval('public.plan_item_id_seq'::regclass);


--
-- Name: plan_repair_event id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plan_repair_event ALTER COLUMN id SET DEFAULT nextval('public.plan_repair_event_id_seq'::regclass);


--
-- Name: portion_option id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.portion_option ALTER COLUMN id SET DEFAULT nextval('public.portion_option_id_seq'::regclass);


--
-- Name: review_queue id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.review_queue ALTER COLUMN id SET DEFAULT nextval('public.review_queue_id_seq'::regclass);


--
-- Name: session id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.session ALTER COLUMN id SET DEFAULT nextval('public.session_id_seq'::regclass);


--
-- Name: subscription id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.subscription ALTER COLUMN id SET DEFAULT nextval('public.subscription_id_seq'::regclass);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: client_account client_account_client_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.client_account
    ADD CONSTRAINT client_account_client_id_key UNIQUE (client_id);


--
-- Name: client_account client_account_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.client_account
    ADD CONSTRAINT client_account_pkey PRIMARY KEY (id);


--
-- Name: client_constraint client_constraint_client_id_kind_constraint_key_value_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.client_constraint
    ADD CONSTRAINT client_constraint_client_id_kind_constraint_key_value_key UNIQUE (client_id, kind, constraint_key, value);


--
-- Name: client_constraint client_constraint_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.client_constraint
    ADD CONSTRAINT client_constraint_pkey PRIMARY KEY (id);


--
-- Name: client_exclusion client_exclusion_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.client_exclusion
    ADD CONSTRAINT client_exclusion_pkey PRIMARY KEY (id);


--
-- Name: client client_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.client
    ADD CONSTRAINT client_pkey PRIMARY KEY (id);


--
-- Name: client_session client_session_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.client_session
    ADD CONSTRAINT client_session_pkey PRIMARY KEY (id);


--
-- Name: client_session client_session_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.client_session
    ADD CONSTRAINT client_session_token_hash_key UNIQUE (token_hash);


--
-- Name: clinician clinician_email_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.clinician
    ADD CONSTRAINT clinician_email_key UNIQUE (email);


--
-- Name: clinician clinician_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.clinician
    ADD CONSTRAINT clinician_pkey PRIMARY KEY (id);


--
-- Name: daily_log daily_log_client_id_log_date_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.daily_log
    ADD CONSTRAINT daily_log_client_id_log_date_key UNIQUE (client_id, log_date);


--
-- Name: daily_log daily_log_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.daily_log
    ADD CONSTRAINT daily_log_pkey PRIMARY KEY (id);


--
-- Name: evidence evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.evidence
    ADD CONSTRAINT evidence_pkey PRIMARY KEY (id);


--
-- Name: followup followup_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.followup
    ADD CONSTRAINT followup_pkey PRIMARY KEY (id);


--
-- Name: food_allergen food_allergen_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.food_allergen
    ADD CONSTRAINT food_allergen_pkey PRIMARY KEY (food_item_id, allergen);


--
-- Name: food_diet_tag food_diet_tag_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.food_diet_tag
    ADD CONSTRAINT food_diet_tag_pkey PRIMARY KEY (food_item_id, tag);


--
-- Name: food_ingredient food_ingredient_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.food_ingredient
    ADD CONSTRAINT food_ingredient_pkey PRIMARY KEY (food_item_id, ingredient_name);


--
-- Name: food_item food_item_canonical_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.food_item
    ADD CONSTRAINT food_item_canonical_id_key UNIQUE (canonical_id);


--
-- Name: food_item food_item_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.food_item
    ADD CONSTRAINT food_item_pkey PRIMARY KEY (id);


--
-- Name: login_attempt login_attempt_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.login_attempt
    ADD CONSTRAINT login_attempt_pkey PRIMARY KEY (id);


--
-- Name: meal_checkin meal_checkin_client_id_plan_item_id_log_date_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.meal_checkin
    ADD CONSTRAINT meal_checkin_client_id_plan_item_id_log_date_key UNIQUE (client_id, plan_item_id, log_date);


--
-- Name: meal_checkin meal_checkin_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.meal_checkin
    ADD CONSTRAINT meal_checkin_pkey PRIMARY KEY (id);


--
-- Name: nutrition_original nutrition_original_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.nutrition_original
    ADD CONSTRAINT nutrition_original_pkey PRIMARY KEY (food_item_id);


--
-- Name: nutrition_per100 nutrition_per100_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.nutrition_per100
    ADD CONSTRAINT nutrition_per100_pkey PRIMARY KEY (food_item_id);


--
-- Name: nutrition_serving nutrition_serving_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.nutrition_serving
    ADD CONSTRAINT nutrition_serving_pkey PRIMARY KEY (food_item_id);


--
-- Name: organization_entitlement organization_entitlement_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.organization_entitlement
    ADD CONSTRAINT organization_entitlement_pkey PRIMARY KEY (organization_id, feature_code);


--
-- Name: organization organization_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.organization
    ADD CONSTRAINT organization_pkey PRIMARY KEY (id);


--
-- Name: organization organization_slug_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.organization
    ADD CONSTRAINT organization_slug_key UNIQUE (slug);


--
-- Name: plan plan_client_id_version_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plan
    ADD CONSTRAINT plan_client_id_version_key UNIQUE (client_id, version);


--
-- Name: plan_day plan_day_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plan_day
    ADD CONSTRAINT plan_day_pkey PRIMARY KEY (id);


--
-- Name: plan_day plan_day_plan_id_day_index_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plan_day
    ADD CONSTRAINT plan_day_plan_id_day_index_key UNIQUE (plan_id, day_index);


--
-- Name: plan_item plan_item_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plan_item
    ADD CONSTRAINT plan_item_pkey PRIMARY KEY (id);


--
-- Name: plan plan_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plan
    ADD CONSTRAINT plan_pkey PRIMARY KEY (id);


--
-- Name: plan_repair_event plan_repair_event_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plan_repair_event
    ADD CONSTRAINT plan_repair_event_pkey PRIMARY KEY (id);


--
-- Name: portion_option portion_option_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.portion_option
    ADD CONSTRAINT portion_option_pkey PRIMARY KEY (id);


--
-- Name: review_queue review_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.review_queue
    ADD CONSTRAINT review_queue_pkey PRIMARY KEY (id);


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);


--
-- Name: session session_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_token_hash_key UNIQUE (token_hash);


--
-- Name: subscription subscription_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.subscription
    ADD CONSTRAINT subscription_pkey PRIMARY KEY (id);


--
-- Name: idx_audit_recent; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_recent ON public.audit_log USING btree (created_at DESC);


--
-- Name: idx_checkin_client; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_checkin_client ON public.meal_checkin USING btree (client_id, log_date DESC);


--
-- Name: idx_client_account_email; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_client_account_email ON public.client_account USING btree (lower(email));


--
-- Name: idx_client_clinician; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_client_clinician ON public.client USING btree (clinician_id);


--
-- Name: idx_client_constraint_client; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_client_constraint_client ON public.client_constraint USING btree (client_id, kind);


--
-- Name: idx_client_constraint_lookup; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_client_constraint_lookup ON public.client_constraint USING btree (client_id, kind, severity, constraint_key, value);


--
-- Name: idx_client_session_account; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_client_session_account ON public.client_session USING btree (client_account_id);


--
-- Name: idx_client_session_lookup; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_client_session_lookup ON public.client_session USING btree (token_hash) WHERE (revoked_at IS NULL);


--
-- Name: idx_clinician_email_lower; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_clinician_email_lower ON public.clinician USING btree (lower(email));


--
-- Name: idx_clinician_org; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_clinician_org ON public.clinician USING btree (organization_id);


--
-- Name: idx_daily_log_client; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_daily_log_client ON public.daily_log USING btree (client_id, log_date DESC);


--
-- Name: idx_evidence_food_item; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_evidence_food_item ON public.evidence USING btree (food_item_id);


--
-- Name: idx_followup_client_date; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_followup_client_date ON public.followup USING btree (client_id, visit_date DESC);


--
-- Name: idx_food_allergen_food; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_food_allergen_food ON public.food_allergen USING btree (food_item_id);


--
-- Name: idx_food_allergen_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_food_allergen_name ON public.food_allergen USING btree (lower(allergen));


--
-- Name: idx_food_diet_tag_food; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_food_diet_tag_food ON public.food_diet_tag USING btree (food_item_id);


--
-- Name: idx_food_diet_tag_tag; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_food_diet_tag_tag ON public.food_diet_tag USING btree (tag);


--
-- Name: idx_food_ingredient_food; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_food_ingredient_food ON public.food_ingredient USING btree (food_item_id);


--
-- Name: idx_food_ingredient_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_food_ingredient_name ON public.food_ingredient USING btree (lower(ingredient_name));


--
-- Name: idx_food_item_allergen_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_food_item_allergen_status ON public.food_item USING btree (allergen_profile_status);


--
-- Name: idx_food_item_brand; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_food_item_brand ON public.food_item USING btree (brand);


--
-- Name: idx_food_item_category; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_food_item_category ON public.food_item USING btree (category);


--
-- Name: idx_food_item_entity; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_food_item_entity ON public.food_item USING btree (entity_type);


--
-- Name: idx_food_item_name_ar; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_food_item_name_ar ON public.food_item USING gin (to_tsvector('simple'::regconfig, name_ar));


--
-- Name: idx_food_item_name_en; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_food_item_name_en ON public.food_item USING gin (to_tsvector('simple'::regconfig, COALESCE(name_en, ''::text)));


--
-- Name: idx_food_item_role; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_food_item_role ON public.food_item USING btree (food_role);


--
-- Name: idx_login_attempt_recent; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_login_attempt_recent ON public.login_attempt USING btree (email, attempted_at DESC);


--
-- Name: idx_plan_client; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_plan_client ON public.plan USING btree (client_id, version DESC);


--
-- Name: idx_plan_client_workflow; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_plan_client_workflow ON public.plan USING btree (client_id, workflow_status, version DESC);


--
-- Name: idx_plan_item_day; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_plan_item_day ON public.plan_item USING btree (plan_day_id);


--
-- Name: idx_plan_quality_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_plan_quality_status ON public.plan USING btree (quality_status);


--
-- Name: idx_plan_repair_event_plan; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_plan_repair_event_plan ON public.plan_repair_event USING btree (plan_id, created_at DESC);


--
-- Name: idx_plan_repair_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_plan_repair_status ON public.plan USING btree (repair_status);


--
-- Name: idx_portion_default_one; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_portion_default_one ON public.portion_option USING btree (food_item_id) WHERE is_default;


--
-- Name: idx_portion_option_food; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_portion_option_food ON public.portion_option USING btree (food_item_id);


--
-- Name: idx_review_queue_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_review_queue_status ON public.review_queue USING btree (status, reason);


--
-- Name: idx_session_clinician; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_session_clinician ON public.session USING btree (clinician_id);


--
-- Name: idx_session_lookup; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_session_lookup ON public.session USING btree (token_hash) WHERE (revoked_at IS NULL);


--
-- Name: idx_subscription_active_org; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_subscription_active_org ON public.subscription USING btree (organization_id) WHERE (status = ANY (ARRAY['TRIAL'::text, 'ACTIVE'::text, 'PAST_DUE'::text, 'PAUSED'::text]));


--
-- Name: v_plan_progress _RETURN; Type: RULE; Schema: public; Owner: postgres
--

CREATE OR REPLACE VIEW public.v_plan_progress AS
 SELECT p.id AS plan_id,
    p.client_id,
    p.version,
    p.approved_at,
    p.quality_status,
    count(f.*) FILTER (WHERE (f.visit_date >= (p.approved_at)::date)) AS followups_since_approval,
    avg(f.adherence_pct) FILTER (WHERE (f.visit_date >= (p.approved_at)::date)) AS avg_adherence_since_approval,
    min(f.weight_kg) FILTER (WHERE (f.visit_date >= (p.approved_at)::date)) AS min_weight_since_approval,
    max(f.weight_kg) FILTER (WHERE (f.visit_date >= (p.approved_at)::date)) AS max_weight_since_approval,
        CASE
            WHEN (p.approved_at IS NULL) THEN 'PLAN_NOT_RELEASED'::text
            WHEN (p.quality_status IS DISTINCT FROM 'PASS'::text) THEN 'PLAN_QUALITY_NOT_PASS'::text
            WHEN (count(f.*) FILTER (WHERE (f.visit_date >= (p.approved_at)::date)) = 0) THEN 'INSUFFICIENT_PROGRESS_DATA'::text
            WHEN (avg(f.adherence_pct) FILTER (WHERE (f.visit_date >= (p.approved_at)::date)) < (60)::numeric) THEN 'LOW_ADHERENCE_IN_PLAN_PERIOD'::text
            ELSE NULL::text
        END AS progress_signal
   FROM (public.plan p
     LEFT JOIN public.followup f ON ((f.client_id = p.client_id)))
  GROUP BY p.id;


--
-- Name: client trg_enforce_client_organization_match; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_enforce_client_organization_match BEFORE INSERT OR UPDATE ON public.client FOR EACH ROW EXECUTE FUNCTION public.enforce_client_organization_match();


--
-- Name: plan trg_enforce_plan_workflow_transition; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_enforce_plan_workflow_transition BEFORE UPDATE ON public.plan FOR EACH ROW EXECUTE FUNCTION public.enforce_plan_workflow_transition();


--
-- Name: plan trg_plan_release_requires_approval; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_plan_release_requires_approval BEFORE UPDATE ON public.plan FOR EACH ROW EXECUTE FUNCTION public.plan_release_requires_approval();


--
-- Name: food_item trg_prevent_food_item_delete; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_prevent_food_item_delete BEFORE DELETE ON public.food_item FOR EACH ROW EXECUTE FUNCTION public.prevent_food_item_delete();


--
-- Name: audit_log audit_log_clinician_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_clinician_id_fkey FOREIGN KEY (clinician_id) REFERENCES public.clinician(id);


--
-- Name: client_account client_account_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.client_account
    ADD CONSTRAINT client_account_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.client(id) ON DELETE CASCADE;


--
-- Name: client client_clinician_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.client
    ADD CONSTRAINT client_clinician_id_fkey FOREIGN KEY (clinician_id) REFERENCES public.clinician(id) ON DELETE CASCADE;


--
-- Name: client_constraint client_constraint_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.client_constraint
    ADD CONSTRAINT client_constraint_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.client(id) ON DELETE CASCADE;


--
-- Name: client_exclusion client_exclusion_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.client_exclusion
    ADD CONSTRAINT client_exclusion_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.client(id) ON DELETE CASCADE;


--
-- Name: client client_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.client
    ADD CONSTRAINT client_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id);


--
-- Name: client_session client_session_client_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.client_session
    ADD CONSTRAINT client_session_client_account_id_fkey FOREIGN KEY (client_account_id) REFERENCES public.client_account(id) ON DELETE CASCADE;


--
-- Name: client_session client_session_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.client_session
    ADD CONSTRAINT client_session_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.client(id) ON DELETE CASCADE;


--
-- Name: clinician clinician_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.clinician
    ADD CONSTRAINT clinician_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE SET NULL;


--
-- Name: daily_log daily_log_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.daily_log
    ADD CONSTRAINT daily_log_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.client(id) ON DELETE CASCADE;


--
-- Name: evidence evidence_food_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.evidence
    ADD CONSTRAINT evidence_food_item_id_fkey FOREIGN KEY (food_item_id) REFERENCES public.food_item(id) ON DELETE CASCADE;


--
-- Name: followup followup_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.followup
    ADD CONSTRAINT followup_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.client(id) ON DELETE CASCADE;


--
-- Name: food_allergen food_allergen_food_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.food_allergen
    ADD CONSTRAINT food_allergen_food_item_id_fkey FOREIGN KEY (food_item_id) REFERENCES public.food_item(id) ON DELETE CASCADE;


--
-- Name: food_diet_tag food_diet_tag_food_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.food_diet_tag
    ADD CONSTRAINT food_diet_tag_food_item_id_fkey FOREIGN KEY (food_item_id) REFERENCES public.food_item(id) ON DELETE CASCADE;


--
-- Name: food_ingredient food_ingredient_food_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.food_ingredient
    ADD CONSTRAINT food_ingredient_food_item_id_fkey FOREIGN KEY (food_item_id) REFERENCES public.food_item(id) ON DELETE CASCADE;


--
-- Name: meal_checkin meal_checkin_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.meal_checkin
    ADD CONSTRAINT meal_checkin_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.client(id) ON DELETE CASCADE;


--
-- Name: meal_checkin meal_checkin_plan_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.meal_checkin
    ADD CONSTRAINT meal_checkin_plan_item_id_fkey FOREIGN KEY (plan_item_id) REFERENCES public.plan_item(id) ON DELETE CASCADE;


--
-- Name: nutrition_original nutrition_original_food_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.nutrition_original
    ADD CONSTRAINT nutrition_original_food_item_id_fkey FOREIGN KEY (food_item_id) REFERENCES public.food_item(id) ON DELETE CASCADE;


--
-- Name: nutrition_per100 nutrition_per100_food_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.nutrition_per100
    ADD CONSTRAINT nutrition_per100_food_item_id_fkey FOREIGN KEY (food_item_id) REFERENCES public.food_item(id) ON DELETE CASCADE;


--
-- Name: nutrition_serving nutrition_serving_food_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.nutrition_serving
    ADD CONSTRAINT nutrition_serving_food_item_id_fkey FOREIGN KEY (food_item_id) REFERENCES public.food_item(id) ON DELETE CASCADE;


--
-- Name: organization_entitlement organization_entitlement_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.organization_entitlement
    ADD CONSTRAINT organization_entitlement_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: plan plan_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plan
    ADD CONSTRAINT plan_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.client(id) ON DELETE CASCADE;


--
-- Name: plan_day plan_day_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plan_day
    ADD CONSTRAINT plan_day_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plan(id) ON DELETE CASCADE;


--
-- Name: plan_item plan_item_food_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plan_item
    ADD CONSTRAINT plan_item_food_item_id_fkey FOREIGN KEY (food_item_id) REFERENCES public.food_item(id);


--
-- Name: plan_item plan_item_plan_day_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plan_item
    ADD CONSTRAINT plan_item_plan_day_id_fkey FOREIGN KEY (plan_day_id) REFERENCES public.plan_day(id) ON DELETE CASCADE;


--
-- Name: plan_item plan_item_substituted_from_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plan_item
    ADD CONSTRAINT plan_item_substituted_from_fkey FOREIGN KEY (substituted_from) REFERENCES public.food_item(id);


--
-- Name: plan_repair_event plan_repair_event_clinician_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plan_repair_event
    ADD CONSTRAINT plan_repair_event_clinician_id_fkey FOREIGN KEY (clinician_id) REFERENCES public.clinician(id);


--
-- Name: plan_repair_event plan_repair_event_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plan_repair_event
    ADD CONSTRAINT plan_repair_event_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plan(id) ON DELETE CASCADE;


--
-- Name: plan plan_superseded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plan
    ADD CONSTRAINT plan_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES public.plan(id);


--
-- Name: portion_option portion_option_food_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.portion_option
    ADD CONSTRAINT portion_option_food_item_id_fkey FOREIGN KEY (food_item_id) REFERENCES public.food_item(id) ON DELETE CASCADE;


--
-- Name: review_queue review_queue_food_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.review_queue
    ADD CONSTRAINT review_queue_food_item_id_fkey FOREIGN KEY (food_item_id) REFERENCES public.food_item(id) ON DELETE CASCADE;


--
-- Name: session session_client_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_client_account_id_fkey FOREIGN KEY (client_account_id) REFERENCES public.client_account(id) ON DELETE CASCADE;


--
-- Name: session session_clinician_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_clinician_id_fkey FOREIGN KEY (clinician_id) REFERENCES public.clinician(id) ON DELETE CASCADE;


--
-- Name: subscription subscription_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.subscription
    ADD CONSTRAINT subscription_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict GUpp8AVd2ep044UKypRFePdnjUY4U4jt7kKjHyiJi6d8KIvnWDQyDBc1wpJiygC

