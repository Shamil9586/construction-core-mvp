import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The API container's startup chain is the surface that actually broke the first
// AUTH_MODE=bitrix test deployment ("Demo seed is allowed only in local/mock test
// environments"): scripts/seed.ts is deliberately fail-closed for bitrix, and the
// Dockerfile CMD called it unconditionally. Nothing else in the suite covers infra,
// so this runs the exact CMD string shipped in infra/Dockerfile through /bin/sh with
// `node` replaced by a shell function that only records its arguments. No migration,
// no seed and no server actually run — what is asserted is the real boot sequence.
function apiStartCommand(): string {
    // Committed with LF, but a Windows checkout converts to CRLF, so normalise first.
    const dockerfile = readFileSync('infra/Dockerfile', 'utf8').split('\r\n').join('\n');
    const api = dockerfile.split(/^FROM /m).find(stage => /^\S+ AS api$/.test(stage.split('\n')[0]));
    assert.ok(api, 'infra/Dockerfile must still define an api stage');
    const cmd = api.split('\n').find(line => line.startsWith('CMD '));
    assert.ok(cmd, 'the api stage must still define a CMD');
    const argv = JSON.parse(cmd.slice(4));
    assert.deepEqual(argv.slice(0, 2), ['/bin/sh', '-c'], 'api CMD must stay a /bin/sh -c chain');
    return argv[2];
}

// Returns the scripts the boot chain invoked, in order, plus its exit code.
// `seedExit` simulates scripts/seed.ts failing, to prove the chain stays &&-linked.
function boot(authMode: string | undefined, seedExit = 0) {
    const dir = mkdtempSync(join(tmpdir(), 'startup-'));
    const log = join(dir, 'calls.log');
    // A shell function shadows PATH lookup in POSIX sh, so the command under test runs
    // verbatim while every `node ...` invocation is intercepted instead of executed.
    const stub = 'node() { printf "%s\\n" "$*" >> "$STARTUP_CALL_LOG"; case "$*" in *seed.ts*) return '
        + seedExit + ';; esac; }\n';
    const env: NodeJS.ProcessEnv = { ...process.env, STARTUP_CALL_LOG: log.split('\\').join('/') };
    if (authMode === undefined) delete env.AUTH_MODE; else env.AUTH_MODE = authMode;
    return new Promise<{ scripts: string[]; code: number }>(resolve => {
        execFile('sh', ['-c', stub + apiStartCommand()], { env, cwd: process.cwd() }, (error: any) => {
            let calls: string[] = [];
            try { calls = readFileSync(log, 'utf8').split('\n').filter(Boolean); } catch { calls = []; }
            rmSync(dir, { recursive: true, force: true });
            resolve({ scripts: calls.map(c => c.replace('--import tsx ', '').trim()), code: error ? (error.code ?? 1) : 0 });
        });
    });
}

test('API container startup chain gates the demo seed on AUTH_MODE', async t => {
    await t.test('AUTH_MODE=mock: migrations -> seed -> backend', async () => {
        const { scripts, code } = await boot('mock');
        assert.deepEqual(scripts, ['scripts/migrate.ts', 'scripts/seed.ts', 'apps/backend/src/main.ts']);
        assert.equal(code, 0);
    });

    await t.test('AUTH_MODE=bitrix: migrations -> backend, seed never invoked', async () => {
        const { scripts, code } = await boot('bitrix');
        assert.deepEqual(scripts, ['scripts/migrate.ts', 'apps/backend/src/main.ts']);
        assert.ok(!scripts.some(s => s.includes('seed')));
        assert.equal(code, 0);
    });

    await t.test('Unset AUTH_MODE skips the seed too; main.ts stays the one gate', async () => {
        const { scripts } = await boot(undefined);
        assert.deepEqual(scripts, ['scripts/migrate.ts', 'apps/backend/src/main.ts']);
    });

    await t.test('A failing seed in mock mode still aborts startup', async () => {
        const { scripts, code } = await boot('mock', 3);
        assert.deepEqual(scripts, ['scripts/migrate.ts', 'scripts/seed.ts']);
        assert.notEqual(code, 0);
    });

    await t.test('scripts/seed.ts keeps its own fail-closed guard as defence in depth', () => {
        const seed = readFileSync('scripts/seed.ts', 'utf8');
        assert.match(seed, /process\.env\.AUTH_MODE === "bitrix"/);
        assert.match(seed, /process\.env\.NODE_ENV === "production"/);
        assert.match(seed, /throw Error\("Demo seed is allowed only in local\/mock test environments"\)/);
    });
});
