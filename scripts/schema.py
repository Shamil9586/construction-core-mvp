from pathlib import Path
base=Path(__file__).resolve().parents[1]
tables={
'users':"bitrix_user_id text NOT NULL, name text NOT NULL, email text, department_id text, position text, role text NOT NULL, is_active boolean NOT NULL DEFAULT true, contractor_id uuid",
'contractors':"name text NOT NULL, inn text, contact_data text, status text NOT NULL DEFAULT 'ACTIVE'",
'objects':"external_code text NOT NULL, source text NOT NULL DEFAULT 'MANUAL', name text NOT NULL, address text NOT NULL, customer_name text, organization_name text, project_manager_id uuid NOT NULL, start_date date NOT NULL, planned_finish_date date NOT NULL, actual_finish_date date, contract_value numeric(20,2) NOT NULL CHECK(contract_value>=0), status text NOT NULL DEFAULT 'ACTIVE', health_status text NOT NULL DEFAULT 'GRAY'",
'object_contractors':"object_id uuid NOT NULL, contractor_id uuid NOT NULL",
'work_categories':"parent_id uuid, name text NOT NULL, code text NOT NULL, sort_order int NOT NULL DEFAULT 0, is_active boolean DEFAULT true",
'work_types':"category_id uuid NOT NULL, name text NOT NULL, unit text NOT NULL, requires_inspection boolean DEFAULT true, requires_executive_docs boolean DEFAULT true, requires_materials boolean DEFAULT true, is_active boolean DEFAULT true",
'work_templates':"work_type_id uuid NOT NULL, name text NOT NULL, default_quantity numeric(20,4)",
'works':"object_id uuid NOT NULL, work_type_id uuid NOT NULL, contractor_id uuid NOT NULL, responsible_user_id uuid NOT NULL, name text NOT NULL, unit text NOT NULL, planned_quantity numeric(20,4) NOT NULL CHECK(planned_quantity>0), actual_quantity numeric(20,4) NOT NULL DEFAULT 0 CHECK(actual_quantity>=0), planned_start_date date NOT NULL, planned_finish_date date NOT NULL, actual_start_date date, actual_finish_date date, estimated_cost numeric(20,2) NOT NULL CHECK(estimated_cost>=0), status text NOT NULL DEFAULT 'PLANNED'",
'work_dependencies':"predecessor_work_id uuid NOT NULL, successor_work_id uuid NOT NULL, dependency_type text NOT NULL DEFAULT 'FINISH_TO_START' CHECK(dependency_type='FINISH_TO_START'), requires_acceptance boolean DEFAULT true, requires_document boolean DEFAULT false, CHECK(predecessor_work_id<>successor_work_id)",
'work_progress':"object_work_id uuid NOT NULL, quantity_delta numeric(20,4) NOT NULL, total_quantity numeric(20,4) NOT NULL, progress_percent numeric(7,4), reported_at timestamptz NOT NULL DEFAULT now(), reported_by uuid NOT NULL, comment text",
'inspections':"object_id uuid NOT NULL, object_work_id uuid NOT NULL, requested_by uuid NOT NULL, requested_at timestamptz DEFAULT now(), inspector_id uuid, status text NOT NULL DEFAULT 'WAITING', inspection_date timestamptz, decision text, comment text, accepted_at timestamptz",
'issues':"inspection_id uuid NOT NULL, title text NOT NULL, description text, severity text NOT NULL CHECK(severity IN ('LOW','MEDIUM','HIGH','CRITICAL')), responsible_user_id uuid NOT NULL, due_date date NOT NULL, status text NOT NULL DEFAULT 'OPEN', resolved_at timestamptz, resolved_by uuid, verified_at timestamptz, verified_by uuid",
'attachments':"file_provider text NOT NULL DEFAULT 'LOCAL', external_file_id text, file_name text NOT NULL, mime_type text NOT NULL, content bytea, uploaded_by uuid NOT NULL",
'inspection_photos':"inspection_id uuid NOT NULL, issue_id uuid, attachment_id uuid NOT NULL, uploaded_by uuid NOT NULL, metadata jsonb",
'materials':"name text NOT NULL, manufacturer text, brand text, type text",
'material_batches':"material_id uuid NOT NULL, batch_number text NOT NULL, supplier text, delivery_date date, object_id uuid NOT NULL",
'material_documents':"material_batch_id uuid NOT NULL, type text NOT NULL, number text NOT NULL, valid_from date, valid_until date, file_id uuid NOT NULL",
'work_materials':"object_work_id uuid NOT NULL, material_batch_id uuid NOT NULL, quantity numeric(20,4) NOT NULL CHECK(quantity>0)",
'executive_documents':"object_id uuid NOT NULL, object_work_id uuid NOT NULL, type text NOT NULL, number text NOT NULL, document_date date NOT NULL, status text NOT NULL DEFAULT 'DRAFT', file_id uuid, draft_content text, created_by uuid NOT NULL, approved_by uuid, approved_at timestamptz",
'executive_packages':"object_id uuid NOT NULL, object_work_id uuid NOT NULL, status text NOT NULL DEFAULT 'DRAFT', created_by uuid NOT NULL, completed_at timestamptz",
'package_documents':"package_id uuid NOT NULL, document_id uuid NOT NULL",
'pto_transfers':"package_id uuid NOT NULL, transferred_by uuid NOT NULL, transferred_at timestamptz DEFAULT now()",
'sdo_cases':"object_id uuid NOT NULL, object_work_id uuid NOT NULL, executive_document_package_id uuid NOT NULL, status text NOT NULL DEFAULT 'TRANSFERRED', pto_transferred_at timestamptz DEFAULT now(), pto_transferred_by uuid NOT NULL, sdo_responsible_id uuid, estimated_value numeric(20,2), calculated_value numeric(20,2), accepted_closing_value numeric(20,2), calculated_at timestamptz, closed_at timestamptz, comment text",
'financial_closings':"object_id uuid NOT NULL, sdo_case_id uuid NOT NULL, period text NOT NULL, amount numeric(20,2) NOT NULL CHECK(amount>0), closing_date date NOT NULL, created_by uuid NOT NULL, idempotency_key uuid NOT NULL",
'monthly_plans':"object_id uuid NOT NULL, period text NOT NULL, planned_value numeric(20,2) NOT NULL CHECK(planned_value>=0), plan_type text NOT NULL CHECK(plan_type IN ('INTERMEDIATE','FINAL'))",
'audit_logs':"user_id uuid NOT NULL, entity_type text NOT NULL, entity_id uuid NOT NULL, action text NOT NULL, old_value jsonb, new_value jsonb, ip text",
'domain_events':"event_type text NOT NULL, entity_id uuid NOT NULL, payload jsonb NOT NULL, processed_at timestamptz",
'notifications':"user_id uuid NOT NULL, event_id uuid, title text NOT NULL, dedupe_key text NOT NULL, read_at timestamptz",
'dictionary_items':"kind text NOT NULL, code text NOT NULL, name text NOT NULL, is_active boolean DEFAULT true",
'risk_settings':"yellow_variance numeric DEFAULT -5, red_variance numeric DEFAULT -15, stale_days int DEFAULT 7, pto_days int DEFAULT 5, sdo_days int DEFAULT 10, escalate_technical_days int DEFAULT 3, escalate_director_days int DEFAULT 7",
'bitrix_installations':"portal text NOT NULL, member_id text NOT NULL, encrypted_access_token text NOT NULL, encrypted_refresh_token text NOT NULL, expires_at timestamptz NOT NULL",
'sessions':"user_id uuid NOT NULL, token_hash text NOT NULL, expires_at timestamptz NOT NULL",
'import_reports':"created_by uuid NOT NULL, file_name text NOT NULL, status text NOT NULL DEFAULT 'PREVIEW', report jsonb NOT NULL"
}
sql="CREATE TABLE tenants(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),portal text UNIQUE NOT NULL,member_id text UNIQUE NOT NULL,name text NOT NULL,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());\n"
for t,cols in tables.items():
 sql+=f"CREATE TABLE {t}(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),{cols},created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version int NOT NULL DEFAULT 1,UNIQUE(tenant_id,id));\nCREATE INDEX {t}_tenant_idx ON {t}(tenant_id);\n"
refs={'project_manager_id':'users','contractor_id':'contractors','object_id':'objects','category_id':'work_categories','work_type_id':'work_types','responsible_user_id':'users','predecessor_work_id':'works','successor_work_id':'works','object_work_id':'works','reported_by':'users','requested_by':'users','inspector_id':'users','inspection_id':'inspections','resolved_by':'users','verified_by':'users','uploaded_by':'users','issue_id':'issues','attachment_id':'attachments','material_id':'materials','material_batch_id':'material_batches','file_id':'attachments','created_by':'users','approved_by':'users','package_id':'executive_packages','document_id':'executive_documents','transferred_by':'users','executive_document_package_id':'executive_packages','pto_transferred_by':'users','sdo_responsible_id':'users','sdo_case_id':'sdo_cases','user_id':'users','event_id':'domain_events'}
import re
for t,cols in tables.items():
 for col,target in refs.items():
  if re.search(r'\b'+col+r' uuid',cols):sql+=f'ALTER TABLE {t} ADD FOREIGN KEY(tenant_id,{col}) REFERENCES {target}(tenant_id,id);\nCREATE INDEX {t}_{col}_idx ON {t}(tenant_id,{col});\n'
 if 'status text' in cols:sql+=f'CREATE INDEX {t}_status_idx ON {t}(tenant_id,status);\n'
 sql+=f'CREATE INDEX {t}_created_idx ON {t}(tenant_id,created_at);\n'
for t,cols in {'users':'bitrix_user_id','objects':'source,external_code','object_contractors':'object_id,contractor_id','work_dependencies':'predecessor_work_id,successor_work_id','package_documents':'package_id,document_id','pto_transfers':'package_id','sdo_cases':'executive_document_package_id','financial_closings':'idempotency_key','notifications':'dedupe_key','risk_settings':'tenant_id','bitrix_installations':'member_id','sessions':'token_hash','monthly_plans':'object_id,period,plan_type'}.items():
 sql+=f'CREATE UNIQUE INDEX {t}_unique ON {t}({"" if cols=="tenant_id" else "tenant_id,"}{cols});\n'
sql+="ALTER TABLE work_categories ADD FOREIGN KEY(tenant_id,parent_id) REFERENCES work_categories(tenant_id,id);\nALTER TABLE objects ADD CHECK(planned_finish_date>=start_date);\nALTER TABLE works ADD CHECK(planned_finish_date>=planned_start_date);\nCREATE INDEX works_deadline ON works(tenant_id,planned_finish_date);\nCREATE UNIQUE INDEX inspection_active ON inspections(tenant_id,object_work_id) WHERE status IN ('WAITING','IN_REVIEW','ISSUES_FOUND','REINSPECTION');\nCREATE FUNCTION immutable_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Append-only history'; END $$;\nCREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION immutable_history();\nCREATE TRIGGER progress_immutable BEFORE UPDATE OR DELETE ON work_progress FOR EACH ROW EXECUTE FUNCTION immutable_history();\nCREATE TRIGGER closing_immutable BEFORE UPDATE OR DELETE ON financial_closings FOR EACH ROW EXECUTE FUNCTION immutable_history();\n"
(base/'infra/001_initial.sql').write_text(sql)
(base/'docs/er-diagram.md').write_text('# ER-модель\n\n```mermaid\nerDiagram\n'+''.join(f'    TENANT ||--o{{ {t.upper()} : owns\n' for t in tables)+'```\n\nВсе межтабличные связи содержат tenant_id; SQL-миграция является полным определением FK.\n')
