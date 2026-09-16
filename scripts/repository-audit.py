"""Read-only candidate-file audit. Never prints matched secret values.
Uses temporary Git metadata when the source has no Git history.
Heuristic scan, not a guarantee against all possible secret formats.
"""
from pathlib import Path
import subprocess,tempfile,re,json
root=Path(__file__).resolve().parents[1]
has_git=(root/'.git').exists()
base=['git','-C',str(root)]
if not has_git:
    temp=tempfile.mkdtemp(prefix='construction-git-audit-')
    subprocess.run(['git','init','--bare','--quiet',temp],check=True)
    base=['git','--git-dir='+temp,'--work-tree='+str(root)]
raw=subprocess.check_output(base+['ls-files','--cached','--others','--exclude-standard','-z'])
files=sorted(set(x for x in raw.decode().split('\0') if x))
patterns={
 'private-key':r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
 'github-token':r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})',
 'aws-key':r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b',
 'jwt':r'\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}',
 'credential-url':r'(?:postgres(?:ql)?|mysql|https?)://[^\s/:]+:([^\s@]+)@',
}
findings=[]
for filename in files:
 p=root/filename
 if p.is_symlink():findings.append({'file':filename,'rule':'symlink-review'});continue
 if not p.is_file():continue
 text=p.read_text(errors='replace')
 for rule,pat in patterns.items():
  for m in re.finditer(pat,text):
   if rule=='credential-url' and (m.group(1) in ['postgres','change-me'] or '${' in m.group(1)):continue
   findings.append({'file':filename,'line':text.count('\n',0,m.start())+1,'rule':rule})
print(json.dumps({'gitHistory': 'present: requires history scan' if has_git else 'absent: no commits to scan','candidateCount':len(files),'files':files,'findings':findings},ensure_ascii=False,indent=2))
raise SystemExit(bool(findings))
