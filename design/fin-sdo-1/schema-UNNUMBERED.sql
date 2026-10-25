-- FIN-SDO-1 additive schema DRAFT. UNNUMBERED intentionally.
-- DO NOT APPLY to LIVE or commit as infra/NNN_*.sql without central reservation.
-- Apply only to disposable PostgreSQL after integration/security review.
-- migration-class: additive
CREATE TABLE fin_historical_subjects(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 name text NOT NULL CHECK(length(btrim(name)) > 0),
 address text,
 customer_name text,
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES users(tenant_id,id)
);
CREATE TABLE fin_subjects(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 origin text NOT NULL CHECK(origin IN ('CORE','HISTORICAL')),
 core_object_id uuid,
 historical_subject_id uuid,
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),
 CHECK((origin='CORE' AND core_object_id IS NOT NULL AND historical_subject_id IS NULL) OR
       (origin='HISTORICAL' AND historical_subject_id IS NOT NULL AND core_object_id IS NULL)),
 FOREIGN KEY(tenant_id,core_object_id) REFERENCES objects(tenant_id,id),
 FOREIGN KEY(tenant_id,historical_subject_id) REFERENCES fin_historical_subjects(tenant_id,id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES users(tenant_id,id)
);
CREATE UNIQUE INDEX fin_core_subject_one ON fin_subjects(tenant_id,core_object_id) WHERE core_object_id IS NOT NULL;
CREATE UNIQUE INDEX fin_historical_subject_one ON fin_subjects(tenant_id,historical_subject_id) WHERE historical_subject_id IS NOT NULL;

CREATE TABLE fin_historical_parties(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 name text NOT NULL CHECK(length(btrim(name))>0),
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES users(tenant_id,id)
);
CREATE TABLE fin_party_scopes(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 kind text NOT NULL CHECK(kind IN ('CORE_CONTRACTOR','HISTORICAL_PARTY','UNALLOCATED')),
 core_contractor_id uuid,
 historical_party_id uuid,
 UNIQUE(tenant_id,id),
 CHECK ((kind='CORE_CONTRACTOR' AND core_contractor_id IS NOT NULL AND historical_party_id IS NULL) OR
        (kind='HISTORICAL_PARTY' AND core_contractor_id IS NULL AND historical_party_id IS NOT NULL) OR
        (kind='UNALLOCATED' AND core_contractor_id IS NULL AND historical_party_id IS NULL)),
 FOREIGN KEY(tenant_id,core_contractor_id) REFERENCES contractors(tenant_id,id),
 FOREIGN KEY(tenant_id,historical_party_id) REFERENCES fin_historical_parties(tenant_id,id)
);
CREATE UNIQUE INDEX fin_party_core_one ON fin_party_scopes(tenant_id,core_contractor_id) WHERE core_contractor_id IS NOT NULL;
CREATE UNIQUE INDEX fin_party_hist_one ON fin_party_scopes(tenant_id,historical_party_id) WHERE historical_party_id IS NOT NULL;
CREATE UNIQUE INDEX fin_party_unallocated_one ON fin_party_scopes(tenant_id) WHERE kind='UNALLOCATED';

CREATE TABLE fin_contract_scopes(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 kind text NOT NULL CHECK(kind IN ('KNOWN','NOT_SPECIFIED')),
 party_scope_id uuid NOT NULL,
 number text,
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),
 CHECK((kind='NOT_SPECIFIED' AND number IS NULL) OR (kind='KNOWN' AND length(btrim(coalesce(number,'')))>0)),
 FOREIGN KEY(tenant_id,party_scope_id) REFERENCES fin_party_scopes(tenant_id,id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES users(tenant_id,id)
);
CREATE UNIQUE INDEX fin_contract_known_reference_one ON fin_contract_scopes(tenant_id,party_scope_id,number) WHERE kind='KNOWN';
CREATE UNIQUE INDEX fin_contract_not_specified_one ON fin_contract_scopes(tenant_id,party_scope_id) WHERE kind='NOT_SPECIFIED';

CREATE TABLE fin_quarter_plan_books(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 currency_code text NOT NULL DEFAULT 'RUB' CHECK(currency_code='RUB'),
 plan_year integer NOT NULL CHECK(plan_year BETWEEN 2000 AND 2200),
 plan_quarter integer NOT NULL CHECK(plan_quarter BETWEEN 1 AND 4),
 head_revision_no integer NOT NULL DEFAULT 0 CHECK(head_revision_no>=0),
 version integer NOT NULL DEFAULT 0 CHECK(version=head_revision_no),
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,currency_code,plan_year,plan_quarter),
 FOREIGN KEY(tenant_id,created_by) REFERENCES users(tenant_id,id)
);
CREATE TABLE fin_quarter_book_revisions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 book_id uuid NOT NULL,
 revision_no integer NOT NULL CHECK(revision_no>=1),
 previous_total_rub numeric(20,2),
 new_total_rub numeric(20,2) NOT NULL CHECK(new_total_rub >= 10000000.00),
 reason text,
 actor_id uuid NOT NULL,
 effective_on date NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 command_id uuid NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,book_id,id), UNIQUE(tenant_id,book_id,revision_no),
 CHECK((revision_no=1 AND previous_total_rub IS NULL) OR (revision_no>1 AND previous_total_rub IS NOT NULL AND length(btrim(coalesce(reason,'')))>0)),
 FOREIGN KEY(tenant_id,book_id) REFERENCES fin_quarter_plan_books(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id)
);
CREATE TABLE fin_quarter_plan_lines(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 book_id uuid NOT NULL,
 subject_id uuid NOT NULL,
 party_scope_id uuid NOT NULL,
 contract_scope_id uuid NOT NULL,
 currency_code text NOT NULL DEFAULT 'RUB' CHECK(currency_code='RUB'),
 created_in_book_revision integer NOT NULL CHECK(created_in_book_revision>=1),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,book_id,id), UNIQUE(tenant_id,book_id,subject_id,party_scope_id,contract_scope_id,currency_code),
 FOREIGN KEY(tenant_id,book_id) REFERENCES fin_quarter_plan_books(tenant_id,id),
 FOREIGN KEY(tenant_id,subject_id) REFERENCES fin_subjects(tenant_id,id),
 FOREIGN KEY(tenant_id,party_scope_id) REFERENCES fin_party_scopes(tenant_id,id),
 FOREIGN KEY(tenant_id,contract_scope_id) REFERENCES fin_contract_scopes(tenant_id,id)
);
CREATE TABLE fin_quarter_plan_line_revisions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 book_revision_id uuid NOT NULL,
 book_id uuid NOT NULL,
 plan_line_id uuid NOT NULL,
 line_revision_no integer NOT NULL CHECK(line_revision_no>=1),
 previous_amount_rub numeric(20,2),
 new_amount_rub numeric(20,2) NOT NULL CHECK(new_amount_rub>=0),
 actor_id uuid NOT NULL,
 effective_on date NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 reason text,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,plan_line_id,line_revision_no),
 FOREIGN KEY(tenant_id,book_id,book_revision_id) REFERENCES fin_quarter_book_revisions(tenant_id,book_id,id),
 FOREIGN KEY(tenant_id,book_id,plan_line_id) REFERENCES fin_quarter_plan_lines(tenant_id,book_id,id),
 FOREIGN KEY(tenant_id,book_id) REFERENCES fin_quarter_plan_books(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id)
);
CREATE TABLE fin_plan_edit_sessions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 actor_id uuid NOT NULL,
 plan_year integer NOT NULL CHECK(plan_year BETWEEN 2000 AND 2200),
 plan_quarter integer NOT NULL CHECK(plan_quarter BETWEEN 1 AND 4),
 expected_book_version integer NOT NULL DEFAULT 0,
 version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id)
);
CREATE TABLE fin_plan_edit_session_lines(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 edit_session_id uuid NOT NULL,
 subject_id uuid NOT NULL,
 party_scope_id uuid NOT NULL,
 contract_scope_id uuid NOT NULL,
 amount_rub numeric(20,2) NOT NULL CHECK(amount_rub>=0 AND mod(amount_rub,10000.00)=0),
 UNIQUE(tenant_id,id),
 UNIQUE(tenant_id,edit_session_id,subject_id,party_scope_id,contract_scope_id),
 FOREIGN KEY(tenant_id,edit_session_id) REFERENCES fin_plan_edit_sessions(tenant_id,id),
 FOREIGN KEY(tenant_id,subject_id) REFERENCES fin_subjects(tenant_id,id),
 FOREIGN KEY(tenant_id,party_scope_id) REFERENCES fin_party_scopes(tenant_id,id),
 FOREIGN KEY(tenant_id,contract_scope_id) REFERENCES fin_contract_scopes(tenant_id,id)
);
CREATE TABLE fin_command_ledger(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 actor_id uuid NOT NULL,
 kind text NOT NULL,
 scope_id uuid NOT NULL,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
 fingerprint text NOT NULL,
 result jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,actor_id,kind,scope_id,idempotency_key),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id)
);

-- Revisions, ledger and original identities are append-only. 
CREATE TRIGGER fin_book_revisions_immutable BEFORE UPDATE OR DELETE ON fin_quarter_book_revisions FOR EACH ROW EXECUTE FUNCTION immutable_history();
CREATE TRIGGER fin_line_revisions_immutable BEFORE UPDATE OR DELETE ON fin_quarter_plan_line_revisions FOR EACH ROW EXECUTE FUNCTION immutable_history();
CREATE TRIGGER fin_command_ledger_immutable BEFORE UPDATE OR DELETE ON fin_command_ledger FOR EACH ROW EXECUTE FUNCTION immutable_history();
-- IMPORTANT RELEASE GATE: runtime DB role MUST NOT have direct table DML permission.
-- FIN command mutations MUST be exposed through a reviewed SECURITY DEFINER write path, 
-- with table ownership distinct from the restricted runtime role.
-- Until role grants and DB-level full-book conservation function exist, THIS SCHEMA IS NOT PRODUCTION READY.


-- SQL conservation proof (DRAFT): these checks run DEFERRED, after the complete
-- multi-line book transaction. A book with head=0 can exist IN a transaction,
-- but can never be committed as an incomplete or below-min official book.
CREATE FUNCTION fin_assert_quarter_book() RETURNS trigger LANGUAGE plpgsql AS $fin$
DECLARE
 t uuid; b uuid; head_no integer; current_total numeric(20,2);
 reported_total numeric(20,2); n_lines bigint; n_valid bigint;
 n_revs bigint; max_no integer;
BEGIN
 t := NEW.tenant_id;
 IF TG_TABLE_NAME = 'fin_quarter_plan_books' THEN b := NEW.id;
 ELSIF TG_TABLE_NAME = 'fin_quarter_book_revisions' THEN b := NEW.book_id;
 ELSIF TG_TABLE_NAME = 'fin_quarter_plan_lines' THEN b := NEW.book_id;
 ELSIF TG_TABLE_NAME = 'fin_quarter_plan_line_revisions' THEN b := NEW.book_id;
 ELSE RAISE EXCEPTION 'FIN_UNKNOWN_CONSERVATION_SOURCE' USING ERRCODE='23514';
 END IF;
 SELECT head_revision_no INTO head_no FROM fin_quarter_plan_books WHERE tenant_id=t AND id=b;
 IF NOT FOUND THEN RAISE EXCEPTION 'FIN_BOOK_MISSING' USING ERRCODE='23514'; END IF;
 IF head_no < 1 THEN RAISE EXCEPTION 'FIN_INCOMPLETE_BOOK' USING ERRCODE='23514'; END IF;
 SELECT count(*),max(revision_no) INTO n_revs,max_no
 FROM fin_quarter_book_revisions WHERE tenant_id=t AND book_id=b;
 IF n_revs<>head_no OR max_no<>head_no THEN
   RAISE EXCEPTION 'FIN_BOOK_HISTORY_GAP' USING ERRCODE='23514';
 END IF;
 SELECT new_total_rub INTO reported_total
 FROM fin_quarter_book_revisions
 WHERE tenant_id=t AND book_id=b AND revision_no=head_no;
 IF reported_total IS NULL OR reported_total < 10000000.00 THEN
   RAISE EXCEPTION 'FIN_QUARTER_TOTAL_BELOW_MIN' USING ERRCODE='23514';
 END IF;
 SELECT count(*),count(r.new_amount_rub),coalesce(sum(r.new_amount_rub),0)
 INTO n_lines,n_valid,current_total
 FROM fin_quarter_plan_lines l LEFT JOIN LATERAL (
   SELECT lr.new_amount_rub
   FROM fin_quarter_plan_line_revisions lr
   JOIN fin_quarter_book_revisions br ON br.tenant_id=lr.tenant_id AND br.id=lr.book_revision_id
   WHERE lr.tenant_id=l.tenant_id AND lr.plan_line_id=l.id AND br.revision_no <=head_no
   ORDER BY br.revision_no DESC LIMIT 1
 ) r ON TRUE
 WHERE l.tenant_id=t AND l.book_id=b AND l.created_in_book_revision <=head_no;
 IF n_lines=0 OR n_lines<>n_valid OR current_total<>reported_total THEN
   RAISE EXCEPTION 'FIN_QUARTER_BOOK_CONSERVATION_FAILED' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$fin$;
CREATE CONSTRAINT TRIGGER fin_book_complete_on_book
 AFTER INSERT OR UPDATE ON fin_quarter_plan_books DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION fin_assert_quarter_book();
CREATE CONSTRAINT TRIGGER fin_book_complete_on_book_revision
 AFTER INSERT ON fin_quarter_book_revisions DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION fin_assert_quarter_book();
CREATE CONSTRAINT TRIGGER fin_book_complete_on_line
 AFTER INSERT ON fin_quarter_plan_lines DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION fin_assert_quarter_book();
CREATE CONSTRAINT TRIGGER fin_book_complete_on_line_revision
 AFTER INSERT ON fin_quarter_plan_line_revisions DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION fin_assert_quarter_book();
CREATE TRIGGER fin_plan_lines_immutable BEFORE UPDATE OR DELETE ON fin_quarter_plan_lines
 FOR EACH ROW EXECUTE FUNCTION immutable_history();
CREATE TRIGGER fin_subjects_immutable BEFORE UPDATE OR DELETE ON fin_subjects
 FOR EACH ROW EXECUTE FUNCTION immutable_history();
CREATE TRIGGER fin_party_scopes_immutable BEFORE UPDATE OR DELETE ON fin_party_scopes
 FOR EACH ROW EXECUTE FUNCTION immutable_history();
CREATE TRIGGER fin_contract_scopes_immutable BEFORE UPDATE OR DELETE ON fin_contract_scopes
 FOR EACH ROW EXECUTE FUNCTION immutable_history();


-- FIN-SDO-1 financial cross-entity identity constraints (native PostgreSQL).
-- Matching tenant alone is not enough: the contract reference must belong to
-- the SAME party used on the plan line; never cross-wire two subcontractors.
ALTER TABLE fin_contract_scopes
 ADD CONSTRAINT fin_contract_tenant_party_id_unique UNIQUE(tenant_id,party_scope_id,id);
ALTER TABLE fin_quarter_plan_lines
 ADD CONSTRAINT fin_quarter_line_party_contract_fk
 FOREIGN KEY(tenant_id,party_scope_id,contract_scope_id)
 REFERENCES fin_contract_scopes(tenant_id,party_scope_id,id);
ALTER TABLE fin_plan_edit_session_lines
 ADD CONSTRAINT fin_buffer_line_party_contract_fk
 FOREIGN KEY(tenant_id,party_scope_id,contract_scope_id)
 REFERENCES fin_contract_scopes(tenant_id,party_scope_id,id);

-- DEC-02: each plan line is an exact hundredth million RUB = 10,000.00 RUB.
ALTER TABLE fin_quarter_plan_line_revisions
 ADD CONSTRAINT fin_line_decimal_precision CHECK(mod(new_amount_rub,10000.00)=0);
ALTER TABLE fin_quarter_book_revisions
 ADD CONSTRAINT fin_total_decimal_precision CHECK(mod(new_total_rub,10000.00)=0);

-- No implicit change of the tenant, calendar quarter or author after original.
-- A book head advances by one atomically. Whole-book conservation at commit
-- rejects an advance without matching immutable history/line revisions.
CREATE FUNCTION fin_guard_book_identity() RETURNS trigger LANGUAGE plpgsql AS $identity$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'FIN_BOOK_IDENTITY_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
    OR NEW.plan_year IS DISTINCT FROM OLD.plan_year
    OR NEW.plan_quarter IS DISTINCT FROM OLD.plan_quarter
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.id IS DISTINCT FROM OLD.id THEN
  RAISE EXCEPTION 'FIN_BOOK_IDENTITY_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 IF NEW.version <> OLD.version+1 OR NEW.head_revision_no<>OLD.head_revision_no+1 THEN
  RAISE EXCEPTION 'FIN_HEAD_MUST_ADVANCE_BY_ONE' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$identity$;
CREATE TRIGGER fin_book_guard BEFORE UPDATE OR DELETE ON fin_quarter_plan_books
 FOR EACH ROW EXECUTE FUNCTION fin_guard_book_identity();

-- FIN-1 supports create-only historical identities. Future edits would require
-- a separately approved immutable history contract.
CREATE TRIGGER fin_historical_subjects_immutable BEFORE UPDATE OR DELETE ON fin_historical_subjects
 FOR EACH ROW EXECUTE FUNCTION immutable_history();
CREATE TRIGGER fin_historical_parties_immutable BEFORE UPDATE OR DELETE ON fin_historical_parties
 FOR EACH ROW EXECUTE FUNCTION immutable_history();

-- At COMMIT, validate all before/after amounts and monotonically numbered
-- line/book histories, not just today's book total (read snapshots depend on it).
CREATE FUNCTION fin_assert_history_links() RETURNS trigger LANGUAGE plpgsql AS $history$
DECLARE t uuid; b uuid;
BEGIN
 t:=NEW.tenant_id;
 IF TG_TABLE_NAME='fin_quarter_book_revisions' THEN b:=NEW.book_id;
 ELSIF TG_TABLE_NAME='fin_quarter_plan_line_revisions' THEN b:=NEW.book_id;
 ELSE RAISE EXCEPTION 'FIN_HISTORY_SCOPE_INVALID' USING ERRCODE='23514';
 END IF;

 IF EXISTS (
  SELECT 1 FROM (
   SELECT revision_no,previous_total_rub,
       row_number() OVER (ORDER BY revision_no) AS n,
       lag(new_total_rub) OVER (ORDER BY revision_no) AS prev
   FROM fin_quarter_book_revisions WHERE tenant_id=t AND book_id=b
  ) r WHERE r.revision_no<>r.n OR r.previous_total_rub IS DISTINCT FROM r.prev
 ) THEN RAISE EXCEPTION 'FIN_BOOK_REVISION_HISTORY_INVALID' USING ERRCODE='23514'; END IF;

 IF EXISTS (
  SELECT 1 FROM (
   SELECT lr.plan_line_id,lr.line_revision_no,lr.previous_amount_rub,
          row_number() OVER (PARTITION BY lr.plan_line_id ORDER BY br.revision_no) AS n,
          lag(lr.new_amount_rub) OVER (PARTITION BY lr.plan_line_id ORDER BY br.revision_no) AS prev,
          min(br.revision_no) OVER (PARTITION BY lr.plan_line_id) AS first_book_no
   FROM fin_quarter_plan_line_revisions lr
   JOIN fin_quarter_book_revisions br ON br.tenant_id=lr.tenant_id AND br.id=lr.book_revision_id
   WHERE lr.tenant_id=t AND lr.book_id=b
  ) r JOIN fin_quarter_plan_lines l ON l.tenant_id=t AND l.id=r.plan_line_id
  WHERE r.line_revision_no<>r.n OR r.previous_amount_rub IS DISTINCT FROM r.prev
        OR r.first_book_no<>l.created_in_book_revision
 ) THEN RAISE EXCEPTION 'FIN_LINE_REVISION_HISTORY_INVALID' USING ERRCODE='23514'; END IF;

 IF EXISTS (
   SELECT 1 FROM fin_quarter_book_revisions br
   WHERE br.tenant_id=t AND br.book_id=b AND NOT EXISTS (
     SELECT 1 FROM fin_quarter_plan_line_revisions lr
     WHERE lr.tenant_id=br.tenant_id AND lr.book_revision_id=br.id
   )
 ) THEN RAISE EXCEPTION 'FIN_EMPTY_BOOK_REVISION' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$history$;
CREATE CONSTRAINT TRIGGER fin_book_history_links
 AFTER INSERT ON fin_quarter_book_revisions DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION fin_assert_history_links();
CREATE CONSTRAINT TRIGGER fin_line_history_links
 AFTER INSERT ON fin_quarter_plan_line_revisions DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION fin_assert_history_links();


-- S-01 trust boundary DESIGN/ISOLATED TEST ONLY.
-- A FIN PostgreSQL limited role must NOT be allowed to select sessions/users or
-- supply arbitrary actor/tenant identity. Only possession of an active bearer
-- session token, hashed with the SAME SHA-256 algorithm as security.ts, can
-- resolve current DB tenant/actor/role. NO caller-writable GUC is trusted.
-- Requires positive and negative native role tests. It is not a write command.
CREATE FUNCTION public.fin_sdo_session_principal(
    p_bearer_token text, p_operation text
) RETURNS TABLE (fin_tenant_id uuid, fin_actor_id uuid, fin_role text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fin_secure$
    SELECT u.tenant_id, u.id, u.role
    FROM public.sessions s
    JOIN public.users u ON u.tenant_id=s.tenant_id AND u.id=s.user_id
    WHERE s.token_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_bearer_token, 'UTF8')), 'hex')
      AND s.expires_at > pg_catalog.now()
      AND u.is_active = true
      AND pg_catalog.length(p_bearer_token) BETWEEN 32 AND 256
      AND (
        (p_operation='READ' AND u.role IN ('SDO','SDO_HEAD','GENERAL_DIRECTOR','DEPUTY_DIRECTOR','ADMIN'))
        OR (p_operation='WRITE' AND u.role IN ('SDO','SDO_HEAD','ADMIN'))
      )
      AND p_operation IN ('READ','WRITE')
    LIMIT 1;
$fin_secure$;
REVOKE ALL ON FUNCTION public.fin_sdo_session_principal(text,text) FROM PUBLIC;
-- Deliberately no GRANT EXECUTE here. The DB security deployment must grant
-- solely to the exact restricted FIN runtime principal under separate review.
-- A standalone legacy DB login must not gain FIN write capability by default.


-- S-01 PROTECTED WRITE VERTICAL SLICE (isolated validation only).
-- The FIN runtime role has no direct table DML or session SELECT.
-- Token is the actual opaque HTTP bearer; PostgreSQL derives actor/tenant/role
-- from sessions/users itself, never from a client UUID or writable GUC.
-- A command uses an advisory lock and the FIN ledger in the caller's tx.c.
-- This handles HISTORICAL SUBJECT CREATION only; other FIN writers still
-- need individually reviewed privileged functions before SEC-01 can close.
CREATE FUNCTION public.fin_sdo_create_historical_subject(
 p_bearer_token text,
 p_name text,
 p_address text,
 p_customer_name text,
 p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fin_create_subject$
DECLARE
 v_tenant uuid;
 v_actor uuid;
 v_name text;
 v_fp text;
 v_previous record;
 v_id uuid;
 v_payload jsonb;
 v_result jsonb;
BEGIN
 SELECT p.fin_tenant_id, p.fin_actor_id
 INTO v_tenant, v_actor
 FROM public.fin_sdo_session_principal(p_bearer_token, 'WRITE') p;

 IF v_actor IS NULL THEN
   RAISE EXCEPTION 'FIN_SESSION_OR_WRITE_ROLE_DENIED' USING ERRCODE='42501';
 END IF;

 v_name:=pg_catalog.btrim(p_name);
 IF v_name IS NULL OR pg_catalog.length(v_name) NOT BETWEEN 1 AND 250
    OR pg_catalog.length(p_address)>500
    OR pg_catalog.length(p_customer_name)>250
    OR p_idempotency_key IS NULL
    OR pg_catalog.length(p_idempotency_key) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'FIN_SUBJECT_INPUT_INVALID' USING ERRCODE='23514';
 END IF;

 v_payload:=pg_catalog.jsonb_build_object(
    'name', v_name,
    'address', p_address,
    'customerName', p_customer_name
 );
 v_fp:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_payload::text,'UTF8')),'hex');
 PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_tenant::text||':'||v_actor::text||
      ':historical-subject-create:'||p_idempotency_key,713)
 );

 SELECT l.fingerprint, l.result INTO v_previous
 FROM public.fin_command_ledger l
 WHERE l.tenant_id=v_tenant
   AND l.actor_id=v_actor AND l.kind='historical-subject-create'
   AND l.scope_id=v_tenant AND l.idempotency_key=p_idempotency_key;

 IF FOUND THEN
   IF v_previous.fingerprint<>v_fp THEN
      RAISE EXCEPTION 'FIN_IDEMPOTENCY_PAYLOAD_MISMATCH' USING ERRCODE='23505';
   END IF;
   RETURN v_previous.result;
 END IF;

 INSERT INTO public.fin_historical_subjects(tenant_id,name,address,customer_name,created_by)
 VALUES(v_tenant,v_name,p_address,p_customer_name,v_actor) RETURNING id INTO v_id;

 v_result:=pg_catalog.jsonb_build_object('id',v_id,'name',v_name,'origin','HISTORICAL');
 INSERT INTO public.fin_command_ledger(
    tenant_id,actor_id,kind,scope_id,idempotency_key,fingerprint,result
 ) VALUES (
    v_tenant,v_actor,'historical-subject-create',v_tenant,p_idempotency_key,v_fp,v_result
 );
 RETURN v_result;
END;
$fin_create_subject$;
REVOKE ALL ON FUNCTION public.fin_sdo_create_historical_subject(text,text,text,text,text) FROM PUBLIC;
-- Deployment gate: GRANT EXECUTE only to FIN runtime role AFTER complete
-- privilege review, not to the main product pool or arbitrary DB principals.


-- S-01 protected historical party writer (isolated candidate).
-- This remains unnumbered; no public EXECUTE grants. The tenant and actor are
-- obtained from the active, role-checked bearer, never passed as input.
CREATE FUNCTION public.fin_sdo_create_historical_party(
  p_bearer_token text, p_name text, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fin_create_party$
DECLARE
  v_tenant uuid;
  v_actor uuid;
  v_name text;
  v_fp text;
  v_existing record;
  v_id uuid;
  v_payload jsonb;
  v_result jsonb;
BEGIN
  SELECT p.fin_tenant_id,p.fin_actor_id INTO v_tenant,v_actor
  FROM public.fin_sdo_session_principal(p_bearer_token,'WRITE') p;

  IF v_tenant IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'FIN_SESSION_OR_WRITE_ROLE_DENIED' USING ERRCODE='42501';
  END IF;
  v_name := pg_catalog.btrim(p_name);
  IF v_name IS NULL OR pg_catalog.length(v_name) NOT BETWEEN 1 AND 250
    OR p_idempotency_key IS NULL OR
       pg_catalog.length(p_idempotency_key) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'FIN_PARTY_INPUT_INVALID' USING ERRCODE='23514';
  END IF;

  v_payload:=pg_catalog.jsonb_build_object('name',v_name);
  v_fp:=pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(v_payload::text,'UTF8')), 'hex'
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_tenant::text||':'||v_actor::text||
        ':historical-party-create:'||p_idempotency_key,713)
  );
  SELECT l.fingerprint,l.result INTO v_existing
  FROM public.fin_command_ledger l
  WHERE l.tenant_id=v_tenant AND l.actor_id=v_actor
    AND l.kind='historical-party-create'
    AND l.scope_id=v_tenant AND l.idempotency_key=p_idempotency_key;

  IF FOUND THEN
    IF v_existing.fingerprint<>v_fp THEN
      RAISE EXCEPTION 'FIN_IDEMPOTENCY_PAYLOAD_MISMATCH' USING ERRCODE='23505';
    END IF;
    RETURN v_existing.result;
  END IF;

  INSERT INTO public.fin_historical_parties(tenant_id,name,created_by)
  VALUES (v_tenant,v_name,v_actor) RETURNING id INTO v_id;
  v_result:=pg_catalog.jsonb_build_object('id',v_id,'name',v_name);
  INSERT INTO public.fin_command_ledger(
      tenant_id,actor_id,kind,scope_id,idempotency_key,fingerprint,result
  ) VALUES (
      v_tenant,v_actor,'historical-party-create',v_tenant,
      p_idempotency_key,v_fp,v_result
  );
  RETURN v_result;
END;
$fin_create_party$;
REVOKE ALL ON FUNCTION public.fin_sdo_create_historical_party(text,text,text) FROM PUBLIC;
-- Grant EXECUTE to only the approved FIN restricted role following independent
-- authorization and successful full protected-path tests, not in product LIVE.
