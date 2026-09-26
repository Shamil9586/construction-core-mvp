const EmbeddedPostgres = require('embedded-postgres').default;
// Native PostgreSQL requires a real unprivileged OS user. Never mutate host users.
(async () => {
  if (process.getuid?.() === 0) throw Error('Run db:local as an existing non-root OS user, or use Docker Compose. No users will be created automatically.');
  // Без явных флагов initdb наследует локаль ОС: на Windows с русской системной
  // кодовой страницей кластер создаётся в WIN1251, и тестовые данные вроде 'м³'
  // (U+00B3) сохранить нельзя — PostgreSQL отвечает «has no equivalent in
  // encoding WIN1251». Кодировка и локаль задаются явно, чтобы локальный кластер
  // был одинаковым на любой ОС. Production-миграции и схему это не затрагивает.
  const pg = new EmbeddedPostgres({databaseDir:'.local-pg',user:'postgres',password:process.env.LOCAL_PG_PASSWORD??'local-test-only',port:54329,persistent:true,createPostgresUser:false,initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1']});
  await pg.initialise();await pg.start();const c=pg.getPgClient();await c.connect();if(!(await c.query("SELECT 1 FROM pg_database WHERE datname='construction_test'")).rowCount)await c.query("CREATE DATABASE construction_test TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'");await c.end();console.log('LOCAL_POSTGRES_READY:54329');
  const stop=async()=>{await pg.stop();process.exit(0)};process.on('SIGTERM',stop);process.on('SIGINT',stop);setInterval(()=>{},60000);
})().catch(e=>{console.error(e.message);process.exit(1)});
