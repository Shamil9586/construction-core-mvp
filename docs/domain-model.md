# Предметная модель

| Domain | SQL |
|---|---|
| Tenant | tenants |
| BitrixInstallation | bitrix_installations |
| User | users |
| ConstructionObject, Contractor, ObjectContractor | objects, contractors, object_contractors |
| WorkCategory, WorkType, WorkTemplate | work_categories, work_types, work_templates |
| ObjectWork, WorkDependency, WorkProgress | works, work_dependencies, work_progress |
| ConstructionInspection, InspectionIssue, InspectionPhoto | inspections, issues, inspection_photos |
| Material, MaterialBatch, MaterialDocument, WorkMaterial | materials, material_batches, material_documents, work_materials |
| ExecutiveDocument, ExecutiveDocumentPackage | executive_documents, executive_packages, package_documents |
| PtoTransfer, SdoCase, FinancialClosing | pto_transfers, sdo_cases, financial_closings |
| Attachment, AuditLog, Notification, DictionaryItem | attachments, audit_logs, notifications, dictionary_items |
| MonthlyPlan, RiskSettings, DomainEvent, ImportReport, Session | monthly_plans, risk_settings, domain_events, import_reports, sessions |

Имена полей SQL — snake_case; REST — camelCase. UUID первичные ключи, tenant_id обязателен в дочерних данных. Деньги numeric(20,2), физические объёмы numeric(20,4). Проценты, scheduleStatus и управляющий health возвращаются projection; физический факт и история — authoritative data. Справочники и шаблоны есть в схеме; полноценный редактор дерева и шаблонов ещё не завершён.
