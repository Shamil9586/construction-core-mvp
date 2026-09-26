import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * F7 — production-like local serving, with a real backend and database.
 *
 * TEST TYPE: production-like local serving + REAL backend/database. Nothing is
 * intercepted and nothing is deployed. This setup:
 *
 *   1. builds with the repository's own commands:
 *        npm run build        → legacy only (the unchanged default)
 *        npm run build:core   → legacy + Core (VITE_DATA_PROVIDER=real)
 *        npm run build:core   → without VITE_DATA_PROVIDER: must be REFUSED
 *      plus two Core bundles built *around* the build:core guard (see
 *      build-core-without-guard.mjs) to prove the runtime also fails safely;
 *   2. starts the real NestJS backend twice on disposable PGlite databases,
 *      migrated (and, for mock auth, seeded) by the repository's own scripts:
 *      once with AUTH_MODE=mock, once with AUTH_MODE=bitrix;
 *   3. serves each build with a real Caddy running infra/Caddyfile — the only
 *      change is `root * /srv` → the build directory (asserted: exactly the
 *      file's two `root` lines, nothing else), because /srv is the container
 *      path of the production image.
 *
 * Caddy is not a repository dependency: set CADDY_BIN, or have `caddy` on
 * PATH. Without it this suite FAILS with an explanation — it never passes by
 * skipping. Everything it creates lives under one temporary directory that
 * teardown removes.
 */

const repoRoot = path.resolve(__dirname, '../..');

interface Started {
  child: ChildProcess;
  label: string;
  log: string;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function withoutDataProvider(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy.VITE_DATA_PROVIDER;
  return copy;
}

function run(label: string, command: string, args: string[], env: NodeJS.ProcessEnv): { status: number | null; output: string } {
  const result = spawnSync(command, args, { cwd: repoRoot, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.error) throw new Error(`${label}: could not start ${command}: ${result.error.message}`);
  return { status: result.status, output };
}

function runOrThrow(label: string, command: string, args: string[], env: NodeJS.ProcessEnv): string {
  const { status, output } = run(label, command, args, env);
  if (status !== 0) throw new Error(`${label} failed (exit ${status}):\n${output.slice(-4000)}`);
  return output;
}

function start(label: string, command: string, args: string[], env: NodeJS.ProcessEnv, logDir: string): Started {
  const log = path.join(logDir, `${label}.log`);
  const fd = openSync(log, 'a');
  const child = spawn(command, args, { cwd: repoRoot, env, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  return { child, label, log };
}

async function waitForHttp(url: string, started: Started, timeoutMs = 90000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    if (started.child.exitCode !== null) {
      throw new Error(`${started.label} exited (${started.child.exitCode}) before ${url} answered:\n${tail(started.log)}`);
    }
    try {
      const response = await fetch(url);
      if (response.status === 200) return;
      last = `HTTP ${response.status}`;
    } catch (error: unknown) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${started.label}: ${url} did not answer 200 within ${timeoutMs}ms (last: ${last}):\n${tail(started.log)}`);
}

function tail(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8').slice(-3000) : '(no log)';
}

function caddyBinary(): string {
  const candidate = process.env.CADDY_BIN || 'caddy';
  const probe = spawnSync(candidate, ['version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    throw new Error(
      `F7 production-like suite needs a Caddy binary (the production web image runs caddy:2-alpine). ` +
        `Set CADDY_BIN to a Caddy v2 executable or put \`caddy\` on PATH. Tried: ${candidate}. ` +
        'This suite does not skip: without Caddy it has not verified anything.',
    );
  }
  return candidate;
}

/** infra/Caddyfile with its two `root * /srv` lines pointed at `distDir` — and nothing else changed. */
function caddyfileServing(distDir: string): string {
  const source = readFileSync(path.join(repoRoot, 'infra/Caddyfile'), 'utf8');
  const marker = 'root * /srv';
  const count = source.split(marker).length - 1;
  if (count !== 2) {
    throw new Error(`expected exactly two "${marker}" lines in infra/Caddyfile (Core + legacy handles), found ${count}`);
  }
  const served = source.split(marker).join(`root * "${distDir}"`);
  const changed = source.split('\n').filter((line, index) => line !== served.split('\n')[index]);
  if (changed.length !== 2 || !changed.every((line) => line.trim() === marker)) {
    throw new Error('the served Caddyfile must differ from infra/Caddyfile only in its two root lines');
  }
  return served;
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const caddy = caddyBinary();
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'f7-production-'));
  const logs = path.join(workspace, 'logs');
  mkdirSync(logs);
  const started: Started[] = [];

  const teardown = async (): Promise<void> => {
    for (const process_ of started.reverse()) {
      if (process_.child.exitCode === null) process_.child.kill('SIGTERM');
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const process_ of started) {
      if (process_.child.exitCode === null) process_.child.kill('SIGKILL');
    }
    if (!process.env.F7_KEEP_WORKSPACE) rmSync(workspace, { recursive: true, force: true });
  };

  try {
    /* ---- 1. builds ------------------------------------------------------ */
    const dist = (name: string) => path.join(workspace, name);
    const baseEnv = withoutDataProvider(process.env);

    runOrThrow('npm run build', 'npm', ['run', 'build', '--', '--outDir', dist('dist-legacy')], baseEnv);
    runOrThrow('npm run build:core', 'npm', ['run', 'build:core', '--', '--outDir', dist('dist-core')], {
      ...baseEnv,
      VITE_DATA_PROVIDER: 'real',
    });
    const refused = run('npm run build:core (unconfigured)', 'npm', ['run', 'build:core', '--', '--outDir', dist('dist-refused')], baseEnv);
    writeFileSync(path.join(workspace, 'build-core-refused.json'), JSON.stringify(refused));

    const unguarded = path.join(repoRoot, 'tests/f7-production/build-core-without-guard.mjs');
    runOrThrow('unguarded Core bundle (unset)', 'node', [unguarded, dist('dist-unconfigured')], baseEnv);
    runOrThrow('unguarded Core bundle (invalid)', 'node', [unguarded, dist('dist-invalid')], {
      ...baseEnv,
      VITE_DATA_PROVIDER: 'staging',
    });

    /* ---- 2. real backends on disposable PGlite databases --------------- */
    const mockKey = randomBytes(18).toString('base64url');
    const backendEnv = (authMode: 'mock' | 'bitrix', port: number): NodeJS.ProcessEnv => ({
      ...baseEnv,
      AUTH_MODE: authMode,
      MOCK_LOGIN_KEY: authMode === 'mock' ? mockKey : '',
      TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      DB_MODE: 'pglite',
      DATABASE_URL: '',
      PGLITE_DIR: path.join(workspace, `pglite-${authMode}`),
      NODE_ENV: 'test',
      TZ: 'UTC',
      BIND_HOST: '127.0.0.1',
      PORT: String(port),
      TRUST_PROXY_HOPS: '1',
      RATE_LIMIT_WINDOW_MS: '60000',
      RATE_LIMIT_MAX: '5000',
      AUTH_RATE_LIMIT_MAX: '500',
    });

    const mockApiPort = await freePort();
    const mockEnv = backendEnv('mock', mockApiPort);
    runOrThrow('migrate (mock)', 'node', ['--import', 'tsx', 'scripts/migrate.ts'], mockEnv);
    runOrThrow('seed (mock)', 'node', ['--import', 'tsx', 'scripts/seed.ts'], mockEnv);
    const mockApi = start('api-mock', 'node', ['--import', 'tsx', 'apps/backend/src/main.ts'], mockEnv, logs);
    started.push(mockApi);

    const bitrixApiPort = await freePort();
    const bitrixEnv = backendEnv('bitrix', bitrixApiPort);
    runOrThrow('migrate (bitrix)', 'node', ['--import', 'tsx', 'scripts/migrate.ts'], bitrixEnv);
    const bitrixApi = start('api-bitrix', 'node', ['--import', 'tsx', 'apps/backend/src/main.ts'], bitrixEnv, logs);
    started.push(bitrixApi);

    await waitForHttp(`http://127.0.0.1:${mockApiPort}/health`, mockApi);
    await waitForHttp(`http://127.0.0.1:${bitrixApiPort}/health`, bitrixApi);

    /* ---- 3. Caddy with infra/Caddyfile, one per build ------------------ */
    const serve = async (label: string, distDir: string, apiPort: number): Promise<string> => {
      const port = await freePort();
      const adminPort = await freePort();
      const home = path.join(workspace, `caddy-${label}`);
      mkdirSync(home);
      const config = path.join(home, 'Caddyfile');
      writeFileSync(config, caddyfileServing(distDir));
      const server = start(`caddy-${label}`, caddy, ['run', '--config', config, '--adapter', 'caddyfile'], {
        ...baseEnv,
        APP_HOST: `:${port}`,
        BACKEND_UPSTREAM: `http://127.0.0.1:${apiPort}`,
        CADDY_ADMIN: `127.0.0.1:${adminPort}`,
        XDG_DATA_HOME: path.join(home, 'data'),
        XDG_CONFIG_HOME: path.join(home, 'config'),
      }, logs);
      started.push(server);
      const url = `http://127.0.0.1:${port}`;
      await waitForHttp(`${url}/`, server);
      return url;
    };

    process.env.F7_CORE_URL = await serve('core', dist('dist-core'), mockApiPort);
    process.env.F7_LEGACY_URL = await serve('legacy', dist('dist-legacy'), mockApiPort);
    process.env.F7_BITRIX_URL = await serve('core-bitrix', dist('dist-core'), bitrixApiPort);
    process.env.F7_UNCONFIGURED_URL = await serve('unconfigured', dist('dist-unconfigured'), mockApiPort);
    process.env.F7_INVALID_URL = await serve('invalid', dist('dist-invalid'), mockApiPort);
    process.env.F7_MOCK_LOGIN_KEY = mockKey;
    process.env.F7_WORKSPACE = workspace;
  } catch (error) {
    await teardown();
    throw error;
  }

  return teardown;
}
