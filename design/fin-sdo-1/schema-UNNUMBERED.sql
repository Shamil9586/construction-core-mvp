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
CREATE FUNCTION fin_assert_quarter_book() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $fin$
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
 SELECT head_revision_no INTO head_no FROM public.fin_quarter_plan_books WHERE tenant_id=t AND id=b;
 IF NOT FOUND THEN RAISE EXCEPTION 'FIN_BOOK_MISSING' USING ERRCODE='23514'; END IF;
 IF head_no < 1 THEN RAISE EXCEPTION 'FIN_INCOMPLETE_BOOK' USING ERRCODE='23514'; END IF;
 SELECT count(*),max(revision_no) INTO n_revs,max_no
 FROM public.fin_quarter_book_revisions WHERE tenant_id=t AND book_id=b;
 IF n_revs<>head_no OR max_no<>head_no THEN
   RAISE EXCEPTION 'FIN_BOOK_HISTORY_GAP' USING ERRCODE='23514';
 END IF;
 SELECT new_total_rub INTO reported_total
 FROM public.fin_quarter_book_revisions
 WHERE tenant_id=t AND book_id=b AND revision_no=head_no;
 IF reported_total IS NULL OR reported_total < 10000000.00 THEN
   RAISE EXCEPTION 'FIN_QUARTER_TOTAL_BELOW_MIN' USING ERRCODE='23514';
 END IF;
 SELECT count(*),count(r.new_amount_rub),coalesce(sum(r.new_amount_rub),0)
 INTO n_lines,n_valid,current_total
 FROM public.fin_quarter_plan_lines l LEFT JOIN LATERAL (
   SELECT lr.new_amount_rub
   FROM public.fin_quarter_plan_line_revisions lr
   JOIN public.fin_quarter_book_revisions br ON br.tenant_id=lr.tenant_id AND br.id=lr.book_revision_id
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
CREATE FUNCTION fin_assert_history_links() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $history$
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
   FROM public.fin_quarter_book_revisions WHERE tenant_id=t AND book_id=b
  ) r WHERE r.revision_no<>r.n OR r.previous_total_rub IS DISTINCT FROM r.prev
 ) THEN RAISE EXCEPTION 'FIN_BOOK_REVISION_HISTORY_INVALID' USING ERRCODE='23514'; END IF;

 IF EXISTS (
  SELECT 1 FROM (
   SELECT lr.plan_line_id,lr.line_revision_no,lr.previous_amount_rub,
          row_number() OVER (PARTITION BY lr.plan_line_id ORDER BY br.revision_no) AS n,
          lag(lr.new_amount_rub) OVER (PARTITION BY lr.plan_line_id ORDER BY br.revision_no) AS prev,
          min(br.revision_no) OVER (PARTITION BY lr.plan_line_id) AS first_book_no
   FROM public.fin_quarter_plan_line_revisions lr
   JOIN public.fin_quarter_book_revisions br ON br.tenant_id=lr.tenant_id AND br.id=lr.book_revision_id
   WHERE lr.tenant_id=t AND lr.book_id=b
  ) r JOIN public.fin_quarter_plan_lines l ON l.tenant_id=t AND l.id=r.plan_line_id
  WHERE r.line_revision_no<>r.n OR r.previous_amount_rub IS DISTINCT FROM r.prev
        OR r.first_book_no<>l.created_in_book_revision
 ) THEN RAISE EXCEPTION 'FIN_LINE_REVISION_HISTORY_INVALID' USING ERRCODE='23514'; END IF;

 IF EXISTS (
   SELECT 1 FROM public.fin_quarter_book_revisions br
   WHERE br.tenant_id=t AND br.book_id=b AND NOT EXISTS (
     SELECT 1 FROM public.fin_quarter_plan_line_revisions lr
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


-- S-01 protected READ projections. Both functions are SECURITY DEFINER,
-- derive tenant/role from CURRENT SESSION bearer, grant no direct FIN SELECT
-- to the login, and expose no caller-selectable tenant_id or object UUID.
-- Read commands use the same externally supplied REPEATABLE READ tx.c.

CREATE FUNCTION public.fin_sdo_read_directory(p_bearer_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $fin_directory$
DECLARE v_tenant uuid; v_output jsonb;
BEGIN
  SELECT p.fin_tenant_id INTO v_tenant
    FROM public.fin_sdo_session_principal(p_bearer_token,'READ') p;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'FIN_SESSION_OR_READ_ROLE_DENIED' USING ERRCODE='42501';
  END IF;
  SELECT pg_catalog.jsonb_build_object(
    'core', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c) ORDER BY c.name,c.id)
      FROM (SELECT o.id,o.name,o.address,o.status FROM public.objects o
            WHERE o.tenant_id=v_tenant) c
    ),'[]'::jsonb),
    'historical', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(h) ORDER BY h.name,h.id)
      FROM (SELECT o.id,o.name,o.address,o.customer_name FROM public.fin_historical_subjects o
            WHERE o.tenant_id=v_tenant) h
    ),'[]'::jsonb),
    'contractors', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(k) ORDER BY k.name,k.id)
      FROM (SELECT o.id,o.name,o.status FROM public.contractors o
            WHERE o.tenant_id=v_tenant) k
    ),'[]'::jsonb),
    'historicalParties', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(hp) ORDER BY hp.name,hp.id)
      FROM (SELECT o.id,o.name FROM public.fin_historical_parties o
            WHERE o.tenant_id=v_tenant) hp
    ),'[]'::jsonb)
  ) INTO v_output;
  RETURN v_output;
END;
$fin_directory$;
REVOKE ALL ON FUNCTION public.fin_sdo_read_directory(text) FROM PUBLIC;

-- As-of recorded_at, not effective_on. A historical view cannot show a
-- later line revision or a later added line, even when effective_on is earlier.
-- No PLAN and explicit ZERO are distinct; director receives full plan
-- history but never private edit buffers.
CREATE FUNCTION public.fin_sdo_read_quarter(
 p_bearer_token text,p_year integer,p_quarter integer,p_known_at timestamptz DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $fin_read_quarter$
DECLARE
 v_tenant uuid; v_book record; v_last record;
 v_history jsonb; v_lines jsonb; v_original text;
BEGIN
 SELECT p.fin_tenant_id INTO v_tenant
 FROM public.fin_sdo_session_principal(p_bearer_token,'READ') p;
 IF v_tenant IS NULL THEN
   RAISE EXCEPTION 'FIN_SESSION_OR_READ_ROLE_DENIED' USING ERRCODE='42501';
 END IF;
 IF p_year NOT BETWEEN 2000 AND 2200 OR p_quarter NOT BETWEEN 1 AND 4 THEN
   RAISE EXCEPTION 'FIN_QUARTER_INVALID' USING ERRCODE='23514';
 END IF;
 SELECT b.id,b.version INTO v_book
 FROM public.fin_quarter_plan_books b
 WHERE b.tenant_id=v_tenant AND b.currency_code='RUB'
   AND b.plan_year=p_year AND b.plan_quarter=p_quarter;
 IF NOT FOUND THEN
   RETURN pg_catalog.jsonb_build_object(
     'status','NO_PLAN','year',p_year,'quarter',p_quarter,
     'currencyCode','RUB','original',NULL,'current',NULL,
     'history','[]'::jsonb,'lines','[]'::jsonb
   );
 END IF;

 SELECT r.revision_no,r.new_total_rub::text AS current
 INTO v_last
 FROM public.fin_quarter_book_revisions r
 WHERE r.tenant_id=v_tenant AND r.book_id=v_book.id
   AND (p_known_at IS NULL OR r.recorded_at<=p_known_at)
 ORDER BY r.revision_no DESC LIMIT 1;
 IF NOT FOUND THEN
   RETURN pg_catalog.jsonb_build_object(
     'status','NO_PLAN_AT_KNOWN_AT','year',p_year,'quarter',p_quarter,
     'currencyCode','RUB','history','[]'::jsonb,'lines','[]'::jsonb
   );
 END IF;

 SELECT r.new_total_rub::text INTO v_original
 FROM public.fin_quarter_book_revisions r
 WHERE r.tenant_id=v_tenant AND r.book_id=v_book.id AND r.revision_no=1;

 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(h) ORDER BY h.revision_no),'[]'::jsonb)
 INTO v_history FROM (
   SELECT r.id,r.revision_no,r.previous_total_rub::text AS previous_total_rub,
     r.new_total_rub::text AS new_total_rub,r.reason,r.actor_id,r.effective_on,r.recorded_at
   FROM public.fin_quarter_book_revisions r
   WHERE r.tenant_id=v_tenant AND r.book_id=v_book.id
     AND r.revision_no<=v_last.revision_no
 ) h;

 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(l) ORDER BY l.id),'[]'::jsonb)
 INTO v_lines FROM (
   SELECT pl.id,pl.subject_id,pl.party_scope_id,pl.contract_scope_id,
     pl.created_in_book_revision, lr.new_amount_rub::text AS amount_rub,
     (CASE WHEN pl.created_in_book_revision=1 THEN (
       SELECT r0.new_amount_rub::text
       FROM public.fin_quarter_plan_line_revisions r0
       JOIN public.fin_quarter_book_revisions b0
         ON b0.tenant_id=r0.tenant_id AND b0.id=r0.book_revision_id
       WHERE r0.tenant_id=pl.tenant_id AND r0.plan_line_id=pl.id
         AND b0.revision_no=1 LIMIT 1
     ) ELSE NULL END) AS original_amount_rub,
     s.origin,s.core_object_id,s.historical_subject_id,
     p.kind AS party_kind,p.core_contractor_id,p.historical_party_id,
     k.kind AS contract_kind,k.number AS contract_number
   FROM public.fin_quarter_plan_lines pl
   JOIN public.fin_subjects s ON s.tenant_id=pl.tenant_id AND s.id=pl.subject_id
   JOIN public.fin_party_scopes p ON p.tenant_id=pl.tenant_id AND p.id=pl.party_scope_id
   JOIN public.fin_contract_scopes k ON k.tenant_id=pl.tenant_id AND k.id=pl.contract_scope_id
   JOIN LATERAL (
     SELECT r.new_amount_rub
     FROM public.fin_quarter_plan_line_revisions r
     JOIN public.fin_quarter_book_revisions br
       ON br.tenant_id=r.tenant_id AND br.id=r.book_revision_id
     WHERE r.tenant_id=pl.tenant_id AND r.plan_line_id=pl.id
       AND br.revision_no<=v_last.revision_no
     ORDER BY br.revision_no DESC LIMIT 1
   ) lr ON TRUE
   WHERE pl.tenant_id=v_tenant AND pl.book_id=v_book.id
     AND pl.created_in_book_revision<=v_last.revision_no
 ) l;

 RETURN pg_catalog.jsonb_build_object(
   'status','ACTIVE','bookId',v_book.id,'bookVersion',v_last.revision_no,
   'revisionNo',v_last.revision_no,'year',p_year,'quarter',p_quarter,
   'currencyCode','RUB','original',v_original,'current',v_last.current,
   'history',v_history,'lines',v_lines
 );
END;
$fin_read_quarter$;
REVOKE ALL ON FUNCTION public.fin_sdo_read_quarter(text,integer,integer,timestamptz) FROM PUBLIC;
-- Runtime login EXECUTE grants are made only in controlled disposable tests
-- and after separate deployment authorization; not from this draft schema.


-- S-01 protected technical buffer CREATE. Every line is resolved inside the
-- privileged function using the verified bearer tenant and minimal DML grants.
-- This draft does NOT create a quarterly plan, original or financial total.
CREATE FUNCTION public.fin_sdo_create_edit_buffer(
 p_bearer_token text, p_year integer, p_quarter integer,
 p_expected_book_version integer, p_lines jsonb
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fin_edit_buffer$
DECLARE
 v_tenant uuid; v_actor uuid; v_current integer;
 v_buffer uuid; v_line jsonb; v_amount numeric;
 v_amount_str text; v_core text; v_hist text; v_party_id text;
 v_subject uuid; v_party uuid; v_contract uuid; v_subject_target uuid;
 v_party_kind text; v_contract_kind text; v_contract_number text;
 v_rows integer; v_total numeric;
BEGIN
 SELECT fin_tenant_id,fin_actor_id INTO v_tenant,v_actor
 FROM public.fin_sdo_session_principal(p_bearer_token,'WRITE');
 IF v_actor IS NULL THEN
   RAISE EXCEPTION 'FIN_SESSION_OR_WRITE_ROLE_DENIED' USING ERRCODE='42501';
 END IF;
 IF p_year NOT BETWEEN 2000 AND 2200 OR p_quarter NOT BETWEEN 1 AND 4
   OR p_expected_book_version IS NULL OR p_expected_book_version < 0
   OR pg_catalog.jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'FIN_BUFFER_INVALID' USING ERRCODE='23514';
 END IF;
 v_rows:=pg_catalog.jsonb_array_length(p_lines);
 IF v_rows NOT BETWEEN 1 AND 1000 THEN
   RAISE EXCEPTION 'FIN_BUFFER_INVALID' USING ERRCODE='23514';
 END IF;

 SELECT b.version INTO v_current FROM public.fin_quarter_plan_books b
 WHERE b.tenant_id=v_tenant AND b.currency_code='RUB'
   AND b.plan_year=p_year AND b.plan_quarter=p_quarter;
 IF COALESCE(v_current,0)<>p_expected_book_version THEN
   RAISE EXCEPTION 'FIN_QUARTER_BOOK_VERSION_CONFLICT' USING ERRCODE='23505';
 END IF;
 INSERT INTO public.fin_plan_edit_sessions(
   tenant_id,actor_id,plan_year,plan_quarter,expected_book_version
 ) VALUES(v_tenant,v_actor,p_year,p_quarter,p_expected_book_version)
 RETURNING id INTO v_buffer;

 FOR v_line IN SELECT value FROM pg_catalog.jsonb_array_elements(p_lines)
 LOOP
   IF pg_catalog.jsonb_typeof(v_line)<>'object' THEN
     RAISE EXCEPTION 'FIN_LINE_INVALID' USING ERRCODE='23514';
   END IF;
   v_core:=NULLIF(v_line->>'coreObjectId','');
   v_hist:=NULLIF(v_line->>'historicalSubjectId','');
   IF (v_core IS NULL)=(v_hist IS NULL) THEN
     RAISE EXCEPTION 'FIN_SUBJECT_XOR' USING ERRCODE='23514';
   END IF;
   v_subject:=NULL;
   IF v_core IS NOT NULL THEN
     SELECT id INTO v_subject_target FROM public.objects
       WHERE tenant_id=v_tenant AND id=v_core::uuid;
     IF NOT FOUND THEN
       RAISE EXCEPTION 'FIN_SUBJECT_NOT_FOUND' USING ERRCODE='42501';
     END IF;
     INSERT INTO public.fin_subjects(
       tenant_id,origin,core_object_id,created_by
     ) VALUES(v_tenant,'CORE',v_subject_target,v_actor)
     ON CONFLICT DO NOTHING RETURNING id INTO v_subject;
     IF v_subject IS NULL THEN
       SELECT id INTO v_subject FROM public.fin_subjects
       WHERE tenant_id=v_tenant AND core_object_id=v_subject_target;
     END IF;
   ELSE
     SELECT id INTO v_subject_target FROM public.fin_historical_subjects
       WHERE tenant_id=v_tenant AND id=v_hist::uuid;
     IF NOT FOUND THEN
       RAISE EXCEPTION 'FIN_SUBJECT_NOT_FOUND' USING ERRCODE='42501';
     END IF;
     INSERT INTO public.fin_subjects(
       tenant_id,origin,historical_subject_id,created_by
     ) VALUES(v_tenant,'HISTORICAL',v_subject_target,v_actor)
     ON CONFLICT DO NOTHING RETURNING id INTO v_subject;
     IF v_subject IS NULL THEN
       SELECT id INTO v_subject FROM public.fin_subjects
       WHERE tenant_id=v_tenant AND historical_subject_id=v_subject_target;
     END IF;
   END IF;
   IF v_subject IS NULL THEN
     RAISE EXCEPTION 'FIN_SUBJECT_CONFLICT' USING ERRCODE='23505';
   END IF;

   v_party_kind:=v_line->>'partyKind';
   v_party_id:=NULLIF(v_line->>'partyId','');
   v_party:=NULL;
   IF v_party_kind='UNALLOCATED' THEN
     IF v_party_id IS NOT NULL THEN
       RAISE EXCEPTION 'FIN_PARTY_INVALID' USING ERRCODE='23514';
     END IF;
     INSERT INTO public.fin_party_scopes(tenant_id,kind)
       VALUES(v_tenant,'UNALLOCATED')
       ON CONFLICT DO NOTHING RETURNING id INTO v_party;
     IF v_party IS NULL THEN
       SELECT id INTO v_party FROM public.fin_party_scopes
       WHERE tenant_id=v_tenant AND kind='UNALLOCATED';
     END IF;
   ELSIF v_party_kind IN ('CORE_CONTRACTOR','HISTORICAL_PARTY') THEN
     IF v_party_id IS NULL THEN
       RAISE EXCEPTION 'FIN_PARTY_REQUIRED' USING ERRCODE='23514';
     END IF;
     IF v_party_kind='CORE_CONTRACTOR' THEN
       PERFORM 1 FROM public.contractors
       WHERE tenant_id=v_tenant AND id=v_party_id::uuid;
       IF NOT FOUND THEN RAISE EXCEPTION 'FIN_PARTY_NOT_FOUND' USING ERRCODE='42501'; END IF;
       INSERT INTO public.fin_party_scopes(tenant_id,kind,core_contractor_id)
         VALUES(v_tenant,'CORE_CONTRACTOR',v_party_id::uuid)
         ON CONFLICT DO NOTHING RETURNING id INTO v_party;
       IF v_party IS NULL THEN
         SELECT id INTO v_party FROM public.fin_party_scopes
         WHERE tenant_id=v_tenant AND core_contractor_id=v_party_id::uuid;
       END IF;
     ELSE
       PERFORM 1 FROM public.fin_historical_parties
       WHERE tenant_id=v_tenant AND id=v_party_id::uuid;
       IF NOT FOUND THEN RAISE EXCEPTION 'FIN_PARTY_NOT_FOUND' USING ERRCODE='42501'; END IF;
       INSERT INTO public.fin_party_scopes(tenant_id,kind,historical_party_id)
         VALUES(v_tenant,'HISTORICAL_PARTY',v_party_id::uuid)
         ON CONFLICT DO NOTHING RETURNING id INTO v_party;
       IF v_party IS NULL THEN
         SELECT id INTO v_party FROM public.fin_party_scopes
         WHERE tenant_id=v_tenant AND historical_party_id=v_party_id::uuid;
       END IF;
     END IF;
   ELSE
     RAISE EXCEPTION 'FIN_PARTY_INVALID' USING ERRCODE='23514';
   END IF;
   IF v_party IS NULL THEN
     RAISE EXCEPTION 'FIN_PARTY_CONFLICT' USING ERRCODE='23505';
   END IF;

   v_contract_kind:=v_line->>'contractKind';
   v_contract_number:=NULLIF(pg_catalog.btrim(v_line->>'contractNumber'),'');
   v_contract:=NULL;
   IF v_contract_kind='NOT_SPECIFIED' THEN
     IF v_contract_number IS NOT NULL THEN
       RAISE EXCEPTION 'FIN_CONTRACT_INVALID' USING ERRCODE='23514';
     END IF;
     INSERT INTO public.fin_contract_scopes(tenant_id,kind,party_scope_id,created_by)
       VALUES(v_tenant,'NOT_SPECIFIED',v_party,v_actor)
       ON CONFLICT DO NOTHING RETURNING id INTO v_contract;
     IF v_contract IS NULL THEN
       SELECT id INTO v_contract FROM public.fin_contract_scopes
         WHERE tenant_id=v_tenant AND party_scope_id=v_party AND kind='NOT_SPECIFIED';
     END IF;
   ELSIF v_contract_kind='KNOWN' THEN
     IF v_contract_number IS NULL OR pg_catalog.length(v_contract_number)>150 THEN
       RAISE EXCEPTION 'FIN_CONTRACT_INVALID' USING ERRCODE='23514';
     END IF;
     INSERT INTO public.fin_contract_scopes(
       tenant_id,kind,party_scope_id,number,created_by
     ) VALUES(v_tenant,'KNOWN',v_party,v_contract_number,v_actor)
       ON CONFLICT DO NOTHING RETURNING id INTO v_contract;
     IF v_contract IS NULL THEN
       SELECT id INTO v_contract FROM public.fin_contract_scopes
       WHERE tenant_id=v_tenant AND party_scope_id=v_party
         AND kind='KNOWN' AND number=v_contract_number;
     END IF;
   ELSE
     RAISE EXCEPTION 'FIN_CONTRACT_INVALID' USING ERRCODE='23514';
   END IF;
   IF v_contract IS NULL THEN
     RAISE EXCEPTION 'FIN_CONTRACT_CONFLICT' USING ERRCODE='23505';
   END IF;

   v_amount_str:=v_line->>'amountMln';
   IF v_amount_str IS NULL OR
     v_amount_str !~ '^(0|[1-9][0-9]{0,13})\.[0-9]{2}$' THEN
     RAISE EXCEPTION 'FIN_AMOUNT_INVALID' USING ERRCODE='23514';
   END IF;
   v_amount:=v_amount_str::numeric * 1000000;
   IF v_amount>=1000000000000000000 THEN
     RAISE EXCEPTION 'FIN_AMOUNT_OUT_OF_RANGE' USING ERRCODE='23514';
   END IF;
   INSERT INTO public.fin_plan_edit_session_lines(
     tenant_id,edit_session_id,subject_id,party_scope_id,contract_scope_id,amount_rub
   ) VALUES(v_tenant,v_buffer,v_subject,v_party,v_contract,v_amount);
 END LOOP;
 SELECT COALESCE(pg_catalog.sum(l.amount_rub),0)
 INTO v_total FROM public.fin_plan_edit_session_lines l
 WHERE l.tenant_id=v_tenant AND l.edit_session_id=v_buffer;
 RETURN pg_catalog.jsonb_build_object(
   'bufferId',v_buffer,'version',1,'uncommitted',true,'totalRub',v_total::text
 );
END;
$fin_edit_buffer$;
REVOKE ALL ON FUNCTION public.fin_sdo_create_edit_buffer(text,integer,integer,integer,jsonb) FROM PUBLIC;
-- No app runtime privileges granted here; reserved migration 035 is NOT written.


-- S-01: list only the actual author-owned technical edit buffers. READ-only
-- director role is explicitly denied the author-scoped edit buffer API.
CREATE FUNCTION public.fin_sdo_list_edit_buffers(
  p_bearer_token text,p_year integer,p_quarter integer
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $fin_list_buffers$
DECLARE v_tenant uuid;v_actor uuid;v_result jsonb;
BEGIN
 SELECT fin_tenant_id,fin_actor_id INTO v_tenant,v_actor
 FROM public.fin_sdo_session_principal(p_bearer_token,'WRITE');
 IF v_actor IS NULL THEN
   RAISE EXCEPTION 'FIN_SESSION_OR_WRITE_ROLE_DENIED' USING ERRCODE='42501';
 END IF;
 IF p_year NOT BETWEEN 2000 AND 2200 OR p_quarter NOT BETWEEN 1 AND 4 THEN
   RAISE EXCEPTION 'FIN_QUARTER_INVALID' USING ERRCODE='23514';
 END IF;
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.updated_at DESC,x.id),'[]'::jsonb)
 INTO v_result FROM (
   SELECT s.id,s.version,s.expected_book_version,s.updated_at,
      COALESCE(pg_catalog.sum(l.amount_rub),0)::text AS total_rub,
      pg_catalog.count(l.id)::int AS line_count
   FROM public.fin_plan_edit_sessions s
   LEFT JOIN public.fin_plan_edit_session_lines l
     ON l.tenant_id=s.tenant_id AND l.edit_session_id=s.id
   WHERE s.tenant_id=v_tenant AND s.actor_id=v_actor
     AND s.plan_year=p_year AND s.plan_quarter=p_quarter
   GROUP BY s.id
   ORDER BY s.updated_at DESC,s.id LIMIT 30
 ) x;
 RETURN v_result;
END;
$fin_list_buffers$;
REVOKE ALL ON FUNCTION public.fin_sdo_list_edit_buffers(text,integer,integer) FROM PUBLIC;

-- Private buffer view includes canonical subject/party/contract references
-- and the CAS version so the client can safely resume its own incomplete work.
CREATE FUNCTION public.fin_sdo_read_edit_buffer(
  p_bearer_token text,p_buffer uuid
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $fin_read_buffer$
DECLARE v_tenant uuid;v_actor uuid;v_buf record;v_lines jsonb;
BEGIN
 SELECT fin_tenant_id,fin_actor_id INTO v_tenant,v_actor
 FROM public.fin_sdo_session_principal(p_bearer_token,'WRITE');
 IF v_actor IS NULL THEN
   RAISE EXCEPTION 'FIN_SESSION_OR_WRITE_ROLE_DENIED' USING ERRCODE='42501';
 END IF;
 SELECT b.id,b.plan_year,b.plan_quarter,b.expected_book_version,b.version
 INTO v_buf
 FROM public.fin_plan_edit_sessions b
 WHERE b.tenant_id=v_tenant AND b.actor_id=v_actor AND b.id=p_buffer;
 IF NOT FOUND THEN
   RAISE EXCEPTION 'FIN_BUFFER_NOT_FOUND_OR_DENIED' USING ERRCODE='42501';
 END IF;
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(l) ORDER BY l.id),'[]'::jsonb)
 INTO v_lines FROM (
    SELECT x.id,x.subject_id,x.party_scope_id,x.contract_scope_id,
      x.amount_rub::text AS amount_rub,
      s.origin,s.core_object_id,s.historical_subject_id,
      p.kind AS party_kind,p.core_contractor_id,p.historical_party_id,
      k.kind AS contract_kind,k.number AS contract_number
    FROM public.fin_plan_edit_session_lines x
    JOIN public.fin_subjects s ON s.tenant_id=x.tenant_id AND s.id=x.subject_id
    JOIN public.fin_party_scopes p ON p.tenant_id=x.tenant_id AND p.id=x.party_scope_id
    JOIN public.fin_contract_scopes k ON k.tenant_id=x.tenant_id AND k.id=x.contract_scope_id
    WHERE x.tenant_id=v_tenant AND x.edit_session_id=p_buffer
 ) l;
 RETURN pg_catalog.jsonb_build_object('buffer',pg_catalog.to_jsonb(v_buf),'lines',v_lines);
END;
$fin_read_buffer$;
REVOKE ALL ON FUNCTION public.fin_sdo_read_edit_buffer(text,uuid) FROM PUBLIC;

-- Replace ALL draft lines via a temporary author-scoped buffer in the same
-- tx.c. This reuses the protected canonical resolver and row/amount validators
-- rather than trusting caller-supplied canonical SQL identifiers.
-- The original id survives. If ANY operation fails, rollback restores all
-- original lines and version; no effective FIN plan is modified.
CREATE FUNCTION public.fin_sdo_update_edit_buffer(
  p_bearer_token text,p_buffer uuid,p_expected_buffer_version integer,
  p_year integer,p_quarter integer,p_expected_book_version integer,p_lines jsonb
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $fin_update_buffer$
DECLARE
 v_tenant uuid;v_actor uuid;v_existing record;
 v_next jsonb;v_temporary uuid;v_total numeric;
BEGIN
 SELECT fin_tenant_id,fin_actor_id INTO v_tenant,v_actor
 FROM public.fin_sdo_session_principal(p_bearer_token,'WRITE');
 IF v_actor IS NULL THEN
   RAISE EXCEPTION 'FIN_SESSION_OR_WRITE_ROLE_DENIED' USING ERRCODE='42501';
 END IF;
 IF p_expected_buffer_version IS NULL OR p_expected_buffer_version<1 THEN
   RAISE EXCEPTION 'FIN_BUFFER_CAS_CONFLICT' USING ERRCODE='23505';
 END IF;
 SELECT b.id,b.version,b.plan_year,b.plan_quarter,b.expected_book_version
 INTO v_existing
 FROM public.fin_plan_edit_sessions b
 WHERE b.tenant_id=v_tenant AND b.actor_id=v_actor AND b.id=p_buffer
 FOR UPDATE;
 IF NOT FOUND THEN
   RAISE EXCEPTION 'FIN_BUFFER_NOT_FOUND_OR_DENIED' USING ERRCODE='42501';
 END IF;
 IF v_existing.version<>p_expected_buffer_version THEN
   RAISE EXCEPTION 'FIN_BUFFER_CAS_CONFLICT' USING ERRCODE='23505';
 END IF;
 IF v_existing.plan_year<>p_year OR v_existing.plan_quarter<>p_quarter
   OR v_existing.expected_book_version<>p_expected_book_version THEN
   RAISE EXCEPTION 'FIN_BUFFER_QUARTER_MISMATCH' USING ERRCODE='23514';
 END IF;
 -- No other commands using FIN's privileged connection may bypass this
 -- validation. A concurrently advanced official book invalidates the draft.
 SELECT pg_catalog.jsonb_extract_path_text(
   public.fin_sdo_create_edit_buffer(
     p_bearer_token,p_year,p_quarter,p_expected_book_version,p_lines
   ),'bufferId'
 )::uuid INTO v_temporary;

 DELETE FROM public.fin_plan_edit_session_lines
 WHERE tenant_id=v_tenant AND edit_session_id=p_buffer;
 UPDATE public.fin_plan_edit_session_lines
 SET edit_session_id=p_buffer
 WHERE tenant_id=v_tenant AND edit_session_id=v_temporary;

 DELETE FROM public.fin_plan_edit_sessions
 WHERE tenant_id=v_tenant AND actor_id=v_actor AND id=v_temporary;

 UPDATE public.fin_plan_edit_sessions SET
   version=version+1,updated_at=pg_catalog.now()
 WHERE tenant_id=v_tenant AND actor_id=v_actor AND id=p_buffer
   AND version=p_expected_buffer_version;

 SELECT COALESCE(pg_catalog.sum(amount_rub),0) INTO v_total
 FROM public.fin_plan_edit_session_lines
 WHERE tenant_id=v_tenant AND edit_session_id=p_buffer;
 RETURN pg_catalog.jsonb_build_object(
   'bufferId',p_buffer,'version',p_expected_buffer_version+1,
   'uncommitted',true,'totalRub',v_total::text
 );
END;
$fin_update_buffer$;
REVOKE ALL ON FUNCTION public.fin_sdo_update_edit_buffer(text,uuid,integer,integer,integer,integer,jsonb) FROM PUBLIC;
-- S-01 still UNNUMBERED, all runtime grants limited to disposable test.

-- S-01 protected official quarter-book commit. This is a separately gated
-- candidate: SECURITY DEFINER owner holds only necessary FIN grants, runtime
-- LOGIN has NO FIN table DML. A single caller-owned tx.c does all writes.
CREATE FUNCTION public.fin_sdo_commit_edit_buffer(
 p_bearer_token text,p_year integer,p_quarter integer,
 p_buffer uuid,p_expected_buffer_version integer,p_expected_book_version integer,
 p_effective_on date,p_reason text,p_idempotency_key text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $fin_commit_book$
DECLARE
 v_tenant uuid;v_actor uuid;v_scope uuid;v_fp text;
 v_previous record;v_buffer record;v_book record;
 v_total numeric;v_count bigint;v_revision integer;
 v_prev_total numeric;v_book_revision_id uuid;
 v_in record;v_old record;v_line_id uuid;v_changed integer:=0;
 v_result jsonb;v_hex text;
BEGIN
 SELECT fin_tenant_id,fin_actor_id INTO v_tenant,v_actor
 FROM public.fin_sdo_session_principal(p_bearer_token,'WRITE');
 IF v_actor IS NULL THEN
   RAISE EXCEPTION 'FIN_SESSION_OR_WRITE_ROLE_DENIED' USING ERRCODE='42501';
 END IF;
 IF p_year NOT BETWEEN 2000 AND 2200 OR p_quarter NOT BETWEEN 1 AND 4
    OR p_expected_book_version IS NULL OR p_expected_book_version<0
    OR p_effective_on IS NULL OR p_idempotency_key IS NULL
    OR pg_catalog.length(p_idempotency_key) NOT BETWEEN 8 AND 128
    OR p_buffer IS NULL OR p_expected_buffer_version IS NULL OR p_expected_buffer_version<1
    OR pg_catalog.length(p_reason)>300 THEN
    RAISE EXCEPTION 'FIN_COMMIT_INVALID' USING ERRCODE='23514';
 END IF;
 IF p_expected_book_version>0 AND pg_catalog.length(pg_catalog.btrim(COALESCE(p_reason,'')))=0 THEN
   RAISE EXCEPTION 'FIN_CORRECTION_REASON_REQUIRED' USING ERRCODE='23514';
 END IF;
 v_hex:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    v_tenant::text||':RUB:'||p_year::text||':'||p_quarter::text,'UTF8'
 )),'hex');
 v_scope:=(pg_catalog.substr(v_hex,1,8)||'-'||pg_catalog.substr(v_hex,9,4)||
     '-4'||pg_catalog.substr(v_hex,14,3)||'-8'||pg_catalog.substr(v_hex,18,3)||
     '-'||pg_catalog.substr(v_hex,21,12))::uuid;
 v_fp:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
   pg_catalog.jsonb_build_object('bufferId',p_buffer,'expectedBufferVersion',p_expected_buffer_version,'year',p_year,
     'quarter',p_quarter,'expectedBookVersion',p_expected_book_version,
     'effectiveOn',p_effective_on,'reason',p_reason)::text,'UTF8'
 )),'hex');

 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
   v_tenant::text||'|'||v_actor::text||'|quarter-commit|'||
   v_scope::text||'|'||p_idempotency_key,713));
 SELECT l.fingerprint,l.result INTO v_previous
 FROM public.fin_command_ledger l WHERE l.tenant_id=v_tenant AND
   l.actor_id=v_actor AND l.kind='quarter-commit' AND
   l.scope_id=v_scope AND l.idempotency_key=p_idempotency_key;
 IF FOUND THEN
   IF v_previous.fingerprint<>v_fp THEN
     RAISE EXCEPTION 'FIN_IDEMPOTENCY_PAYLOAD_MISMATCH' USING ERRCODE='23505';
   END IF;
   RETURN v_previous.result;
 END IF;

 SELECT e.id,e.plan_year,e.plan_quarter,e.expected_book_version,e.version INTO v_buffer
 FROM public.fin_plan_edit_sessions e
 WHERE e.tenant_id=v_tenant AND e.actor_id=v_actor AND e.id=p_buffer
 FOR UPDATE;
 IF NOT FOUND THEN
   RAISE EXCEPTION 'FIN_BUFFER_NOT_FOUND_OR_DENIED' USING ERRCODE='42501';
 END IF;
 IF v_buffer.version<>p_expected_buffer_version THEN
   RAISE EXCEPTION 'FIN_BUFFER_CAS_CONFLICT' USING ERRCODE='23505';
 END IF;
 IF v_buffer.plan_year<>p_year OR v_buffer.plan_quarter<>p_quarter OR
    v_buffer.expected_book_version<>p_expected_book_version THEN
   RAISE EXCEPTION 'FIN_BUFFER_VERSION_CONFLICT' USING ERRCODE='23505';
 END IF;
 SELECT COALESCE(pg_catalog.sum(amount_rub),0),pg_catalog.count(*)
 INTO v_total,v_count
 FROM public.fin_plan_edit_session_lines
 WHERE tenant_id=v_tenant AND edit_session_id=p_buffer;
 IF v_count=0 OR v_total<10000000.00 THEN
   RAISE EXCEPTION 'FIN_QUARTER_TOTAL_BELOW_MIN' USING ERRCODE='23514';
 END IF;

 SELECT b.id,b.version,b.head_revision_no INTO v_book
 FROM public.fin_quarter_plan_books b WHERE b.tenant_id=v_tenant
 AND b.currency_code='RUB' AND b.plan_year=p_year AND b.plan_quarter=p_quarter
 FOR UPDATE;
 IF NOT FOUND THEN
   IF p_expected_book_version<>0 THEN
     RAISE EXCEPTION 'FIN_QUARTER_BOOK_VERSION_CONFLICT' USING ERRCODE='23505';
   END IF;
   INSERT INTO public.fin_quarter_plan_books(tenant_id,currency_code,plan_year,plan_quarter,created_by)
   VALUES(v_tenant,'RUB',p_year,p_quarter,v_actor)
   ON CONFLICT DO NOTHING RETURNING id,version,head_revision_no INTO v_book;
   IF v_book.id IS NULL THEN
     RAISE EXCEPTION 'FIN_QUARTER_BOOK_ALREADY_EXISTS' USING ERRCODE='23505';
   END IF;
 END IF;
 IF v_book.version<>p_expected_book_version THEN
   RAISE EXCEPTION 'FIN_QUARTER_BOOK_VERSION_CONFLICT' USING ERRCODE='23505';
 END IF;
 v_revision:=p_expected_book_version+1;
 v_prev_total:=NULL;
 IF p_expected_book_version>0 THEN
   SELECT r.new_total_rub INTO v_prev_total
   FROM public.fin_quarter_book_revisions r
   WHERE r.tenant_id=v_tenant AND r.book_id=v_book.id
     AND r.revision_no=p_expected_book_version;
   IF v_prev_total IS NULL THEN
     RAISE EXCEPTION 'FIN_BOOK_HISTORY_INVALID' USING ERRCODE='23514';
   END IF;
   -- Existing canonical rows must not be implicitly deleted by omissions.
   IF EXISTS (
     SELECT 1 FROM public.fin_quarter_plan_lines pl
     WHERE pl.tenant_id=v_tenant AND pl.book_id=v_book.id
     AND NOT EXISTS(
       SELECT 1 FROM public.fin_plan_edit_session_lines src
       WHERE src.tenant_id=v_tenant AND src.edit_session_id=p_buffer
         AND src.subject_id=pl.subject_id
         AND src.party_scope_id=pl.party_scope_id
         AND src.contract_scope_id=pl.contract_scope_id
     )
   ) THEN
     RAISE EXCEPTION 'FIN_EXISTING_LINE_OMITTED' USING ERRCODE='23514';
   END IF;
 END IF;

 INSERT INTO public.fin_quarter_book_revisions(
   tenant_id,book_id,revision_no,previous_total_rub,new_total_rub,
   reason,actor_id,effective_on,command_id
 ) VALUES(
   v_tenant,v_book.id,v_revision,v_prev_total,v_total,p_reason,v_actor,
   p_effective_on,pg_catalog.gen_random_uuid()
 ) RETURNING id INTO v_book_revision_id;

 FOR v_in IN SELECT subject_id,party_scope_id,contract_scope_id,amount_rub
   FROM public.fin_plan_edit_session_lines
   WHERE tenant_id=v_tenant AND edit_session_id=p_buffer
   ORDER BY subject_id,party_scope_id,contract_scope_id
 LOOP
   v_line_id:=NULL;
   SELECT pl.id,r.new_amount_rub,r.line_revision_no INTO v_old
   FROM public.fin_quarter_plan_lines pl
   JOIN LATERAL (
     SELECT lr.new_amount_rub,lr.line_revision_no
     FROM public.fin_quarter_plan_line_revisions lr
     JOIN public.fin_quarter_book_revisions br
       ON br.tenant_id=lr.tenant_id AND br.id=lr.book_revision_id
     WHERE lr.tenant_id=pl.tenant_id AND lr.plan_line_id=pl.id
       AND br.revision_no<=p_expected_book_version
     ORDER BY br.revision_no DESC LIMIT 1
   ) r ON TRUE
   WHERE pl.tenant_id=v_tenant AND pl.book_id=v_book.id
     AND pl.subject_id=v_in.subject_id
     AND pl.party_scope_id=v_in.party_scope_id
     AND pl.contract_scope_id=v_in.contract_scope_id;

   IF v_old.id IS NULL THEN
     INSERT INTO public.fin_quarter_plan_lines(
       tenant_id,book_id,subject_id,party_scope_id,contract_scope_id,
       currency_code,created_in_book_revision
     ) VALUES(
       v_tenant,v_book.id,v_in.subject_id,v_in.party_scope_id,
       v_in.contract_scope_id,'RUB',v_revision
     ) RETURNING id INTO v_line_id;
     INSERT INTO public.fin_quarter_plan_line_revisions(
       tenant_id,book_revision_id,book_id,plan_line_id,line_revision_no,
       previous_amount_rub,new_amount_rub,actor_id,effective_on,reason
     ) VALUES(
       v_tenant,v_book_revision_id,v_book.id,v_line_id,1,
       NULL,v_in.amount_rub,v_actor,p_effective_on,p_reason
     );
     v_changed:=v_changed+1;
   ELSIF v_old.new_amount_rub IS DISTINCT FROM v_in.amount_rub THEN
     INSERT INTO public.fin_quarter_plan_line_revisions(
       tenant_id,book_revision_id,book_id,plan_line_id,line_revision_no,
       previous_amount_rub,new_amount_rub,actor_id,effective_on,reason
     ) VALUES(
       v_tenant,v_book_revision_id,v_book.id,v_old.id,v_old.line_revision_no+1,
       v_old.new_amount_rub,v_in.amount_rub,v_actor,p_effective_on,p_reason
     );
     v_changed:=v_changed+1;
   END IF;
 END LOOP;
 IF v_changed=0 THEN
   RAISE EXCEPTION 'FIN_NO_CHANGES' USING ERRCODE='23514';
 END IF;

 UPDATE public.fin_quarter_plan_books
 SET version=v_revision,head_revision_no=v_revision
 WHERE tenant_id=v_tenant AND id=v_book.id AND version=p_expected_book_version;
 IF NOT FOUND THEN
   RAISE EXCEPTION 'FIN_QUARTER_BOOK_VERSION_CONFLICT' USING ERRCODE='23505';
 END IF;

 v_result:=pg_catalog.jsonb_build_object(
   'bookId',v_book.id,'bookVersion',v_revision,
   'revisionNo',v_revision,'totalRub',v_total::text
 );
 INSERT INTO public.fin_command_ledger(
   tenant_id,actor_id,kind,scope_id,idempotency_key,fingerprint,result
 ) VALUES(
   v_tenant,v_actor,'quarter-commit',v_scope,
   p_idempotency_key,v_fp,v_result
 );
 RETURN v_result;
END;
$fin_commit_book$;
REVOKE ALL ON FUNCTION public.fin_sdo_commit_edit_buffer(text,integer,integer,uuid,integer,integer,date,text,text) FROM PUBLIC;
-- Unnumbered isolated SQL only. FIN-SDO-1 acceptance still pending.
