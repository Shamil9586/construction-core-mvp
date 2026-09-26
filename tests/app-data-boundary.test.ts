import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockDataProvider } from '../apps/frontend/src/data/mockDataProvider';
import { demoInspections, demoObjects, demoWorks } from '../apps/frontend/src/screens/demo/fixtures';
import { ROUTE_PATHS, objectPath, workPath } from '../apps/frontend/src/app/routePaths';

/**
 * F5 — data boundary and routing-foundation coverage.
 *
 * Pure-logic checks, no browser: the claims here are about what a function
 * returns for a given input (same reason tests/view-models.test.ts and
 * tests/domain.test.ts test their functions directly). Rendered/interactive
 * coverage of the same pipeline lives in tests/design-system/app.spec.ts.
 */

test('mockDataProvider.getSnapshot resolves with the typed demo fixtures, not an invented shape', async () => {
  const snapshot = await mockDataProvider.getSnapshot();

  assert.equal(snapshot.objects, demoObjects);
  assert.equal(snapshot.works, demoWorks);
  assert.equal(snapshot.inspections, demoInspections);
  // Real, required Snapshot fields C01/O01/W01 never read — present and
  // empty, not omitted and not a fabricated value.
  assert.deepEqual(snapshot.contractors, []);
  assert.deepEqual(snapshot.dependencies, []);
});

test('route path templates match the F5 objective\'s documented shape', () => {
  assert.equal(ROUTE_PATHS.company, '/company');
  assert.equal(ROUTE_PATHS.object, '/object/:objectId');
  assert.equal(ROUTE_PATHS.work, '/object/:objectId/work/:workId');
});

test('objectPath/workPath build a URL from the given id, never a hardcoded one', () => {
  assert.equal(objectPath('demo-object-1'), '/object/demo-object-1');
  assert.equal(
    workPath('demo-object-1', 'demo-work-1-1'),
    '/object/demo-object-1/work/demo-work-1-1',
  );

  // A second call with a different id proves the path is built from the
  // argument, not returning a constant.
  assert.equal(objectPath('demo-object-2'), '/object/demo-object-2');
});

test('objectPath/workPath encode identifiers rather than trusting them verbatim', () => {
  assert.equal(objectPath('has space'), '/object/has%20space');
  assert.equal(workPath('obj/1', 'work?2'), '/object/obj%2F1/work/work%3F2');
});
