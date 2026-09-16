const EmbeddedPostgres = require('embedded-postgres').default;
// Native PostgreSQL requires a real unprivileged OS user. Never mutate host users.
(async () => {
  if (process.getuid?.() === 0) throw Error('Run db:local as an existing non-root OS user, or use Docker Compose. No users will be created automatically.');
  const pg = new EmbeddedPostgres({databaseDir:'.local-pg',user:'postgres',password:process.env.LOCAL_PG_PASSWORD??'local-test-only',port:54329,persistent:true,createPostgresUser:false,postgresFlags:['-h','127.0.0.1']});
  await pg.initialise();await pg.start();const c=pg.getPgClient();await c.connect();if(!(await c.query("SELECT 1 FROM pg_database WHERE datname='construction_test'")).rowCount)await c.query('CREATE DATABASE construction_test');await c.end();console.log('LOCAL_POSTGRES_READY:54329');
  const stop=async()=>{await pg.stop();process.exit(0)};process.on('SIGTERM',stop);process.on('SIGINT',stop);setInterval(()=>{},60000);
})().catch(e=>{console.error(e.message);process.exit(1)});
