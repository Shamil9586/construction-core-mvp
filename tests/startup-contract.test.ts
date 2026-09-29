import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
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

// PBX1-R01: the Bitrix24 launch lands on /app.html, and app.html is emitted only by the
// explicit Core build (F7). The web image copies the build stage's dist/frontend to /srv,
// so the build stage's own command decides whether /srv/app.html exists at all.
function dockerStage(name: string): string {
    const dockerfile = readFileSync('infra/Dockerfile', 'utf8').split('\r\n').join('\n');
    const stage = dockerfile.split(/^FROM /m).find(s => new RegExp('^\\S+ AS ' + name + '$').test(s.split('\n')[0]));
    assert.ok(stage, 'infra/Dockerfile must define a ' + name + ' stage');
    return stage;
}

function buildStageRuns(): string[] {
    return dockerStage('build').split('\n').filter(l => l.startsWith('RUN ')).map(l => l.slice(4).trim());
}

const CORE_BUILD_RUN = 'VITE_DATA_PROVIDER=real npm run build:core';

test('PBX1-R01: the web image build stage produces the Core entry', async t => {
    await t.test('build stage runs the explicit Core build with the real provider, not the legacy-only build', () => {
        assert.deepEqual(buildStageRuns(), ['npm ci', CORE_BUILD_RUN]);
    });

    await t.test('web stage still serves the build output from /srv, and Caddy still routes /app.html to app.html', () => {
        assert.match(dockerStage('web'), /^COPY --from=build \/app\/dist\/frontend \/srv$/m);
        const caddyfile = readFileSync('infra/Caddyfile', 'utf8');
        assert.match(caddyfile, /@core path \/app\.html \/app\.html\/\*/);
        assert.match(caddyfile, /rewrite \* \/app\.html/);
    });

    await t.test('the exact RUN command from the Dockerfile emits index.html and app.html with the real provider baked in', async () => {
        const out = mkdtempSync(join(tmpdir(), 'web-image-'));
        try {
            await new Promise<void>((resolve, reject) => {
                execFile('sh', ['-c', CORE_BUILD_RUN + ' -- --outDir "$OUT_DIR"'],
                    { env: { ...process.env, OUT_DIR: out }, cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 },
                    (error, _stdout, stderr) => error ? reject(new Error(String(stderr) || error.message)) : resolve());
            });
            assert.ok(existsSync(join(out, 'index.html')), 'legacy entry must stay available');
            assert.ok(existsSync(join(out, 'app.html')), 'Core entry app.html must be present');
            const bundle = readdirSync(join(out, 'assets')).filter(f => f.endsWith('.js'))
                .map(f => readFileSync(join(out, 'assets', f), 'utf8')).join('\n');
            // resolveCoreRuntime(import.meta.env.VITE_DATA_PROVIDER, import.meta.env.DEV) is inlined at build time.
            assert.match(bundle, /\(\s*"real"\s*,\s*(!1|false)\s*\)/, 'Core bundle must be compiled with the real provider');
            assert.doesNotMatch(bundle, /\(\s*"mock"\s*,\s*(!1|false)\s*\)/, 'no mock provider may be compiled into the Core bundle');
        } finally {
            rmSync(out, { recursive: true, force: true });
        }
    });
});
