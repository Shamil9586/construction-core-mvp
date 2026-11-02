import type { FinishSystemStage, FinishSystemVersion } from '../../types/finishSystem';

export interface ProvenanceClasses { provenance?: string; exclusions?: string; exclusionItem?: string }

const dash = (value: string | null) => (value && value.length > 0 ? value : '—');

export function StageProvenance({ stage, classes = {} }: { stage: FinishSystemStage; classes?: ProvenanceClasses }) {
  return (
    <dl className={classes.provenance} data-testid="stage-provenance">
      <dt>Версия шаблона-источника</dt>
      <dd data-field="sourceTemplateVersionId">{dash(stage.sourceTemplateVersionId)}</dd>
      <dt>Этап шаблона-источника</dt>
      <dd data-field="sourceTemplateStageId">{dash(stage.sourceTemplateStageId)}</dd>
    </dl>
  );
}

export function VersionExclusions({ exclusions, classes = {} }: { exclusions: FinishSystemVersion['exclusions']; classes?: ProvenanceClasses }) {
  if (exclusions.length === 0) return null;
  return (
    <section className={classes.exclusions} data-testid="version-exclusions">
      <p>Исключений: {exclusions.length}</p>
      <ul>
        {exclusions.map((x) => (
          <li key={`${x.sourceTemplateVersionId}:${x.templateStageId}`} className={classes.exclusionItem} data-testid="exclusion">
            <dl>
              <dt>Этап шаблона</dt>
              <dd data-field="templateStageId">{x.templateStageId}</dd>
              <dt>Версия шаблона-источника</dt>
              <dd data-field="sourceTemplateVersionId">{x.sourceTemplateVersionId}</dd>
              <dt>Причина</dt>
              <dd data-field="reason">{x.reason}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}
