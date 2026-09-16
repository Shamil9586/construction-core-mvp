"""Reproduce the documented local (PGlite) setup in a new disposable directory.
This does not prove Docker/PostgreSQL/browser acceptance. Retains logs, no deletes.
"""
from pathlib import Path
import tempfile, shutil, subprocess, os, json
root=Path(__file__).resolve().parents[1]
target=Path(tempfile.mkdtemp(prefix='construction-clean-room-'))
shutil.copytree(root,target,dirs_exist_ok=True,ignore=shutil.ignore_patterns('node_modules','dist','.env','.local*','test-results','playwright-report','*.zip'))
env={**os.environ,'DB_MODE':'pglite','AUTH_MODE':'mock','MOCK_LOGIN_KEY':'clean-room-disposable-test-key','PGLITE_DIR':str(target/'clean-db')}
commands=[['npm','ci','--fetch-retries=0','--fetch-timeout=20000'],['npm','run','build'],['npm','test'],['npm','run','db:migrate'],['npm','run','db:migrate'],['npm','run','db:seed'],['npm','run','db:seed'],['node','--import','tsx','scripts/runtime-smoke.ts'],['npm','run','test:browser','--','--list']]
results=[]
for i,cmd in enumerate(commands):
    logfile=root/'tests/acceptance'/f'clean-room-{i+1}.txt'
    with logfile.open('w') as out:
        r=subprocess.run(cmd,cwd=target,env=env,stdout=out,stderr=subprocess.STDOUT)
    results.append({'command':' '.join(cmd),'exitCode':r.returncode,'log':str(logfile.relative_to(root))})
    print(results[-1],flush=True)
    if r.returncode: break
(root/'tests/acceptance/clean-room.json').write_text(json.dumps({'directory':str(target),'database':'PGlite, new directory','results':results},indent=2))
raise SystemExit(results[-1]['exitCode'])
