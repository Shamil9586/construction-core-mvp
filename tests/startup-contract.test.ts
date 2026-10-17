import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// API startup must be a direct backend command: schema migration and demo seeding
// are explicit operations, not side effects of restart/redeploy.
function apiStartCommand(): string[] {
    const dockerfile = readFileSync('infra/Dockerfile', 'utf8').split('\r\n').join('\n');
    const api = dockerfile.split(/^FROM /m).find(stage => /^\S+ AS api$/.test(stage.split('\n')[0]));
    assert.ok(api, 'infra/Dockerfile must still define an api stage');
    const cmd = api.split('\n').find(line => line.startsWith('CMD '));
    assert.ok(cmd, 'the api stage must still define a CMD');
    const argv = JSON.parse(cmd.slice(4));
    assert.deepEqual(argv, ['node', '--import', 'tsx', 'apps/backend/src/main.ts'],
        'API CMD must directly start only the backend entrypoint');
    return argv;
}

function composeServiceBlock(compose: string, name: string): string {
    const lines = compose.split('\n');
    const start = lines.findIndex(line => line === `  ${name}:`);
    assert.notEqual(start, -1, `docker-compose.yml must define the ${name} service`);
    let end = start + 1;
    while (end < lines.length && !/^  [A-Za-z0-9_-]+:$/.test(lines[end]) && lines[end] !== 'volumes:') {
        end += 1;
    }
    return lines.slice(start + 1, end).join('\n');
}

test('API container startup is runtime-only', async t => {
    await t.test('API CMD does not invoke migrations or demo seed', () => {
        const argv = apiStartCommand();
        assert.ok(!argv.some(arg => arg.includes('migrate.ts')));
        assert.ok(!argv.some(arg => arg.includes('seed.ts')));
    });

    await t.test('migrations remain explicit and API/worker wait for successful migration', () => {
        const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
        assert.equal(packageJson.scripts['db:migrate'], 'node --import tsx scripts/migrate.ts');
        assert.equal(packageJson.scripts['db:seed'], 'node --import tsx scripts/seed.ts');

        const compose = readFileSync('docker-compose.yml', 'utf8');
        const migration = composeServiceBlock(compose, 'migrate');
        assert.match(migration, /command: \["node", "--import", "tsx", "scripts\/migrate\.ts"\]/,
            'the dedicated migrate service must run only the migration command');
        assert.match(migration, /depends_on:\s*\n\s*db:\s*\{condition: service_healthy\}/,
            'migrations must wait for the database health check');

        for (const serviceName of ['api', 'worker']) {
            const service = composeServiceBlock(compose, serviceName);
            assert.match(service, /depends_on:\s*\n\s*migrate:\s*\{condition: service_completed_successfully\}/,
                `${serviceName} must not start unless the migration service completes successfully`);
        }
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
        // The Dockerfile build stage sets no NODE_ENV, so Vite builds in production mode there. An inherited
        // NODE_ENV (CI sets NODE_ENV=test) would make Vite compile import.meta.env.DEV as true and emit the
        // development JSX runtime, so it is dropped to run the RUN command in the build stage's environment.
        const env: NodeJS.ProcessEnv = { ...process.env, OUT_DIR: out };
        delete env.NODE_ENV;
        try {
            await new Promise<void>((resolve, reject) => {
                execFile('sh', ['-c', CORE_BUILD_RUN + ' -- --outDir "$OUT_DIR"'],
                    { env, cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 },
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
