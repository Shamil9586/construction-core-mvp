import { harness, dt, RP } from './aosr-harness';
import { makeUser, actorByRole, handoffWorkToPto } from './pbx3-fixtures';
import { newPortionFor } from './package-scope';

/**
 * ID-AUTO-2 registry fixtures on top of the AOSR harness (real backend on PGlite, mock auth).
 * Everything goes through the production routes except where a legacy/anomalous state must be reproduced.
 */

/** A second Work on the same Object (the PM adds it), with one Quantity Portion. */
export async function addWork(ctx: any, name: string, label = 'Участок') {
  const { req, login } = await harness();
  const pm = await login('PROJECT_MANAGER');
  const dict = await req('dictionaries');
  const contractors = await req('contractors');
  const type = dict.workTypes.find((w: any) => /штукатур/i.test(w.name)) ?? dict.workTypes[0];
  const work = await req('works', { objectId: ctx.object.id, workTypeId: type.id, contractorId: contractors[0].id, responsibleUserId: pm.id, name, unit: 'м²', plannedQuantity: 500, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '100000' });
  const unit = await req('execution-units', { objectWorkId: work.id, workTypeId: type.id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: RP });
  const portion = await req(`execution-units/${unit.id}/portions`, { label, plannedQuantity: RP });
  await login('PTO');
  return { work, unit, portion };
}

/** A PTO engineer on the Object's current PTO head's functional team — NOT an object member (so only an effective handoff opens a work). */
export async function teamEngineer(name: string) {
  const { req, login } = await harness();
  const head = await actorByRole('PTO_HEAD');
  const user = await makeUser(name, 'PTO');
  await login('DEPUTY_DIRECTOR');
  await req('function-teams/pto/org-members', { memberUserId: user.id, managerUserId: head.id });
  await login('PTO');
  return user;
}

export { makeUser, handoffWorkToPto, newPortionFor };
