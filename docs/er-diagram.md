# Основные связи

Полное определение FK, CHECK и индексов — `infra/001_initial.sql`, `infra/002_invariants.sql`. Каждая tenant-связь содержит tenant_id с обеих сторон.

```mermaid
erDiagram
    ConstructionObject ||--o{ ObjectContractor : assigns
    Contractor ||--o{ ObjectContractor : participates
    ConstructionObject ||--o{ ObjectWork : includes
    Contractor ||--o{ ObjectWork : executes
    WorkCategory ||--o{ WorkType : defines
    WorkType ||--o{ ObjectWork : classifies
    ObjectWork ||--o{ WorkProgress : reports
    ObjectWork ||--o{ WorkDependency : gates
```

```mermaid
erDiagram
    ObjectWork ||--o{ ConstructionInspection : requests
    ConstructionInspection ||--o{ InspectionIssue : identifies
    ConstructionInspection ||--o{ InspectionPhoto : documents
    ObjectWork ||--o{ WorkMaterial : uses
    MaterialBatch ||--o{ WorkMaterial : supplies
    MaterialBatch ||--o{ MaterialDocument : certifies
```

```mermaid
erDiagram
    ObjectWork ||--o{ ExecutiveDocumentPackage : prepares
    ExecutiveDocumentPackage ||--o{ PackageDocument : contains
    ExecutiveDocument ||--o{ PackageDocument : belongs
    ExecutiveDocumentPackage ||--o| PtoTransfer : transfers
    ExecutiveDocumentPackage ||--o| SdoCase : opens
    SdoCase ||--o{ FinancialClosing : records
```

Tenant, User, Attachment, AuditLog, DomainEvent, Notification, RiskSettings, BitrixInstallation и Session — инфраструктурные связи, перечислены в domain-model.md и SQL.
