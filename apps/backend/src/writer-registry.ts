/**
 * GPR-2 R03b — the register of every code path that writes to the database (Roadmap R03b: "полный реестр relevant writers").
 *
 * One row per writer, keyed `<file under apps/backend/src>#<method>`. The row says how the writer takes part in the object coordination
 * protocol (coordination-lock.ts):
 *
 *   SHARED     takes the object's SHARED coordination lock as the first statement of its transaction (fact / SC / PTO / SDO / issue /
 *              documentation writers, and GPR-1 draft edits).
 *   EXCLUSIVE  takes the EXCLUSIVE lock (scope-changing: Work generation, topology, GPR approval; quantity approval joins in R07).
 *   NONE       does not take part, for the stated reason. A NONE row is a decision a reviewer can contest, not an omission.
 *
 * The register is closed by tests/gpr2-r03b-writer-registry.test.ts, which reads the source with the TypeScript compiler and fails when
 *   * a `transaction(` / `getFileStore().transaction(` call or a write issued straight on the pool exists in apps/backend/src and is not a row here
 *     (a NEW writer cannot appear without being classified — the bypass-path check);
 *   * a row names a writer that no longer exists;
 *   * a SHARED / EXCLUSIVE row does not call coordinate() with its own id as the first statement of its transaction callback.
 */
export type WriterMode = 'SHARED' | 'EXCLUSIVE' | 'NONE';
export interface WriterEntry { mode: WriterMode; reason: string }

const S = (reason: string): WriterEntry => ({ mode: 'SHARED', reason });
const X = (reason: string): WriterEntry => ({ mode: 'EXCLUSIVE', reason });
const N = (reason: string): WriterEntry => ({ mode: 'NONE', reason });

const FACT = 'production fact / SC writer of an object';
const SDO = 'SDO / closing writer of an object';
const DOC = 'PTO documentation writer of an object';
const AOSR = 'AOSR writer inside a documentation package (PTO)';
const TENANT = 'tenant-level dictionary or account data: no object, no production quantity invariant';
const AUTHZ = 'changes who may act on an object; every command re-authorises against the current rows in its own transaction, and it holds no quantity invariant';

export const WRITERS = {
    // FIN-SDO-1: tenant financial planning only; never changes production objects or F8.3.
    'fin-sdo-1.service.ts#createHistoricalSubject': N('FIN-only historical subject: own tenant row; no production object change'),
    'fin-sdo-1.service.ts#createHistoricalParty': N('FIN-only historical party: no production party change'),
    'fin-sdo-1.service.ts#saveBuffer': N('FIN technical input buffer, tenant/actor-scoped, no production quantity invariants'),
    'fin-sdo-1.service.ts#commitBuffer': N('FIN quarter-book CAS and ledger, independent of production object coordination'),
    // ---- service.ts: objects, Works, production -------------------------------------------------------------------------------
    'service.ts#createObject': N('creates a new object: nothing can be racing on an object that does not exist yet'),
    'service.ts#assignContractor': S('the contractor assignment is the row progress() locks to admit a fact (eligibility)'),
    'service.ts#editObject': N('object metadata and responsible РП; authorisation is re-read per request; no production quantity invariant'),
    'service.ts#completeWorkPlanning': X('R04: filling previously unknown Work planning fields changes scope'),
    'service.ts#createWork': X('Work generation changes the object scope (TD §12.3 item 1)'),
    'service.ts#dependency': X('technology topology change (TD §12.3 item 1)'),
    'service.ts#start': S(FACT),
    'service.ts#progress': S(FACT),
    'service.ts#requestInspection': S(FACT),
    'service.ts#addIssue': S('issues gate release and SC; ' + FACT),
    'service.ts#issueAction': S('issues gate release and SC; ' + FACT),
    'service.ts#inspectionAction': S('SC decision; ' + FACT),
    'service.ts#createPackage': S('legacy executive package; ' + DOC),
    'service.ts#createDocument': S('legacy executive document; ' + DOC),
    'service.ts#approveDocument': S('legacy executive document; ' + DOC),
    'service.ts#packageAction': S('legacy executive package; ' + DOC),
    'service.ts#calculateSdo': S(SDO),
    'service.ts#close': S(SDO),
    'service.ts#createExecutionUnit': S('allocation structure under a Work; ' + FACT),
    'service.ts#addExecutionUnitLayer': S('allocation structure under a Work; ' + FACT),
    'service.ts#createQuantityPortion': S('allocation structure under a Work; ' + FACT),
    'service.ts#recordPortionFact': S(FACT),
    'service.ts#requestPortionInspection': S('SC request; ' + FACT),
    'service.ts#createDocumentationPackage': S(DOC),
    'service.ts#editDocumentationPackage': S(DOC),
    'service.ts#archiveDocumentationPackage': S(DOC),
    'service.ts#linkDocumentationPackagePortion': S(DOC),
    'service.ts#createDocumentationDocument': S(DOC),
    'service.ts#createDocumentationVersion': S(DOC),
    'service.ts#changeDocumentationPackageStatus': S(DOC),
    'service.ts#returnDocumentationPackageToCorrection': S(DOC),
    'service.ts#registerDocumentationCustomerAcceptance': S('customer acceptance; ' + DOC),
    'service.ts#handoffDocumentationPackageToSdo': S(SDO),
    'service.ts#returnSdoCaseToPto': S(SDO),
    'service.ts#assignSdoResponsible': S(SDO),
    'service.ts#changeSdoClosingStatus': S(SDO),
    'service.ts#setSdoClosingAmount': S(SDO),
    'service.ts#setSdoClosingPortionAllocation': S(SDO),
    'service.ts#cancelSdoClosingPortionAllocation': S(SDO),
    // ---- aosr-service.ts ------------------------------------------------------------------------------------------------------
    'aosr-service.ts#setMethod': S(AOSR),
    'aosr-service.ts#create': S(AOSR),
    'aosr-service.ts#dismissSuggestion': S(AOSR),
    'aosr-service.ts#edit': S(AOSR),
    'aosr-service.ts#remove': S(AOSR),
    'aosr-service.ts#setLinks': S(AOSR),
    'aosr-service.ts#createScheme': S(AOSR),
    'aosr-service.ts#attachSchemeFile': S(AOSR),
    'aosr-service.ts#saveParty': S(AOSR),
    'aosr-service.ts#createMaterial': S(AOSR),
    'aosr-service.ts#addQualityDocument': S(AOSR),
    'aosr-service.ts#generate': S(AOSR),
    'aosr-service.ts#recordCustomerAcceptedQuantity': S('customer-accepted quantity; ' + AOSR),
    // ---- PTO handoff -------------------------------------------------------------------------------------------------------------
    'pto-work-assignment-service.ts#assign': S('PTO handoff of a Work; ' + DOC),
    // ---- GPR-1 (legacy schedule; retired by the cutover, R20/R21) -----------------------------------------------------------------
    'schedule-service.ts#createDraft': S('GPR-1 draft edit (TD §12.3 item 4)'),
    'schedule-service.ts#addEntry': S('GPR-1 draft edit (TD §12.3 item 4)'),
    'schedule-service.ts#editEntry': S('GPR-1 draft edit (TD §12.3 item 4)'),
    'schedule-service.ts#removeEntry': S('GPR-1 draft edit (TD §12.3 item 4)'),
    'schedule-service.ts#discardDraft': S('GPR-1 draft edit (TD §12.3 item 4)'),
    'schedule-service.ts#approveDraft': X('GPR approval switches the operative baseline (TD §12.3 item 4)'),
    'schedule-service.ts#recordDelayReason': S('delay reason attached to an approved revision of an object'),
    'schedule-service.ts#resolveDelayReason': S('delay reason attached to an approved revision of an object'),
    'schedule-service.ts#saveDelayCategory': N(TENANT),
    // ---- imports and files ------------------------------------------------------------------------------------------------------
    'importer.ts#commitImport': N('creates NEW objects (with their contractor link and monthly plan) from an import report; it creates no Work and touches no existing object, and nothing can contend for an object that does not exist yet'),
    'importer.ts#previewImport': N('writes an import report only; creates no object, Work or fact'),
    'file-storage/file-store.ts#transaction': N('generic helper that delegates to transaction(); every caller is registered at its own call site'),
    'modules/attachments/attachments.controller.ts#upload': N('stores a blob; links it to nothing (the link is made by a registered writer)'),
    'modules/inspections/inspections.controller.ts#photo': S('inspection evidence; ' + FACT),
    'modules/materials/materials.controller.ts#bindMaterial': S('binds a material to a Work; ' + DOC),
    // ---- object teams, organisation, accounts ---------------------------------------------------------------------------------
    'team-service.ts#assignOrgMember': N(AUTHZ),
    'team-service.ts#assignObjectLead': N(AUTHZ),
    'team-service.ts#redistribute': N(AUTHZ),
    'team-service.ts#addObjectMember': N(AUTHZ),
    'team-service.ts#endObjectMember': N(AUTHZ),
    'team-service.ts#acknowledgeHandover': N(AUTHZ),
    'team-service.ts#adminCompleteHandover': N(AUTHZ),
    'org-structure-service.ts#assign': N(AUTHZ),
    'org-structure-service.ts#transfer': N(AUTHZ),
    'org-structure-service.ts#end': N(AUTHZ),
    'modules/users/users.controller.ts#addUser': N(TENANT),
    'modules/users/admin-users.controller.ts#add': N(TENANT),
    'modules/users/admin-users.controller.ts#update': N(TENANT),
    'modules/contractors/contractors.controller.ts#addContractor': N(TENANT),
    'modules/dictionaries/dictionaries.controller.ts#risk': N(TENANT),
    'modules/dictionaries/dictionaries.controller.ts#addCategory': N(TENANT),
    'modules/dictionaries/dictionaries.controller.ts#addType': N(TENANT),
    'modules/auth/auth.controller.ts#logout': N('closes the caller\'s own session'),
    // ---- integration and background ----------------------------------------------------------------------------------------------
    'bitrix.ts#installedCall': N('Bitrix24 installation state of the tenant'),
    'bitrix.ts#installBitrix': N('Bitrix24 installation state of the tenant'),
    'bitrix.ts#onAppInstallWebhook': N('Bitrix24 installation state of the tenant'),
    'bitrix-notification-outbox.ts#deliverNextBitrixNotification': N('outbox delivery bookkeeping; writes no production data'),
    'risk-worker.ts#scanRisks': N('derives notifications from the read model; writes no production fact')
} as const satisfies Record<string, WriterEntry>;

export type WriterId = keyof typeof WRITERS;
export const writerEntry = (id: WriterId): WriterEntry => {
    const e = (WRITERS as Record<string, WriterEntry>)[id];
    if (!e)
        throw new Error('writer-registry: unknown writer ' + String(id));
    return e;
};
