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
