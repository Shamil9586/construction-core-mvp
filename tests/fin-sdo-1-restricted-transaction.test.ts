import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { pool } from '../apps/backend/src/db';
import { runCommandTx, runSnapshotRead } from '../apps/backend/src/tx-context';

function fakeConnector() {
  const events: string[] = [];
  let connects=0, releases=0;
  const connect = async ():Promise<PoolClient>=>{
    connects++;
    return {
      query: async (sql: string) => {events.push(sql);return {rows:[{ok:true}]};},
      release: () => {releases++;}
    } as unknown as PoolClient;
  };
  return {connect,events,get connects(){return connects},get releases(){return releases}};
}

test('S-01 restricted connection factory selected before BEGIN; single tx.c used', async () => {
  const x=fakeConnector();
  const value=await runCommandTx(async tx=>{
    assert.equal(tx.kind,'COMMAND');
    assert.equal(tx.attempt,1);
    await tx.c.query('SELECT fin_read');
    assert.throws(()=>pool.query('SELECT separate_connection'), /Nested pool access/);
    return 'verified';
  },{connect:x.connect});
  assert.equal(value,'verified');
  assert.equal(x.connects,1);
  assert.equal(x.releases,1);
  assert.deepEqual(x.events,['BEGIN ISOLATION LEVEL READ COMMITTED','SELECT fin_read','COMMIT']);
});

test('S-01 limited read connector preserves one REPEATABLE READ READ ONLY snapshot', async () => {
  const x=fakeConnector();
  const val=await runSnapshotRead(async tx=>{
    assert.equal(tx.kind,'SNAPSHOT_READ');
    await tx.c.query('SELECT fin_snapshot');
    assert.throws(()=>pool.connect(), /Nested pool access/);
    return 7;
  },x.connect);
  assert.equal(val,7);assert.equal(x.connects,1);assert.equal(x.releases,1);
  assert.deepEqual(x.events,['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY','SELECT fin_snapshot','COMMIT']);
});

test('S-01 failed FIN query performs ROLLBACK and releases only chosen connector', async () => {
  const x=fakeConnector();
  await assert.rejects(()=>runCommandTx(async tx=>{
    await tx.c.query('SELECT limited_permission_denied');
    throw Object.assign(new Error('denied'),{code:'42501'});
  },{connect:x.connect}),/denied/);
  assert.deepEqual(x.events,['BEGIN ISOLATION LEVEL READ COMMITTED','SELECT limited_permission_denied','ROLLBACK']);
  assert.equal(x.connects,1);assert.equal(x.releases,1);
});
