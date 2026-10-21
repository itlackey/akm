from pathlib import Path
import json,sys
r=Path(sys.argv[1]);(r/'library/memories').mkdir(parents=True,exist_ok=True);(r/'library/knowledge').mkdir(exist_ok=True)
assets={}
def put(ref,body,**fields):
 name=ref.split('/')[-1];typ='memory' if ref.startswith('memories/') else 'knowledge'
 text='---\n'+''.join(f'{k}: {json.dumps(v)}\n' for k,v in dict(name=name,type=typ,description=body,**fields).items())+'---\n\n'+body+'\n'
 (r/'library'/f'{ref}.md').write_text(text);assets[ref]=fields
put('memories/quartz-old','Quartz production rollout port 7000. Superseded rollout record.',beliefState='superseded',scope={'user':'alice','agent':'worker','run':'r1','channel':'ops'})
put('memories/quartz-now','Quartz production rollout port 9443. Current rollout procedure and rollback checklist.',beliefState='asserted',scope={'user':'alice','agent':'worker','run':'r2','channel':'ops'})
put('memories/quartz-old.derived','Quartz production rollout port 7000. Historical distilled rollout record.',source='memories/quartz-old')
put('memories/quartz-other','Quartz production rollout port 5555 for Bob only.',beliefState='active',scope={'user':'bob','agent':'other','run':'r3','channel':'private'})
put('knowledge/quartz-guide','Quartz production rollout authentication and rollback reference.')
put('knowledge/cobalt-old','Cobalt retention policy: retain 30 days. Contradicted record.',beliefState='contradicted')
put('knowledge/cobalt-now','Cobalt retention policy: retain 90 days. Current retention policy.',beliefState='active')
put('knowledge/amber-old','Amber retry schedule: wait 2 seconds. Deprecated retry configuration.',beliefState='deprecated')
put('knowledge/amber-now','Amber retry schedule: wait 8 seconds. Current retry configuration.',beliefState='asserted')
put('knowledge/opal','Opal incident response reference for oncall triage.')
put('memories/archived','Violet archived migration incident used port 8080.',beliefState='archived')
queries=[];qrels=[]
def q(id,text,expected,args=None,banned=[]):
 queries.append(dict(id=id,query=text,kind='direct',**({'searchArgs':args} if args else {})))
 for ref in assets:
  qrels.append(dict(id=id,ref=ref,grade=3 if ref in expected else 0,reason='Authored answer to this job.' if ref in expected else 'Wrong job, historical for current job, or excluded by explicit recall policy.',**({'banned':True} if ref in banned else {})))
q('current-rollout','Quartz production rollout',['memories/quartz-now','knowledge/quartz-guide'],banned=['memories/quartz-old','memories/quartz-old.derived'])
q('current-retention','Cobalt retention policy',['knowledge/cobalt-now'],banned=['knowledge/cobalt-old'])
q('current-retries','Amber retry schedule',['knowledge/amber-now'],banned=['knowledge/amber-old'])
q('unflagged','Opal incident response',['knowledge/opal'])
q('history-rollout','Quartz production rollout',['memories/quartz-old','memories/quartz-old.derived'],['--belief','historical'])
q('history-retention','Cobalt retention policy',['knowledge/cobalt-old'],['--belief','historical'])
q('history-deprecated','Amber retry schedule',['knowledge/amber-old'],['--belief','historical'])
q('history-archive','Violet migration incident',['memories/archived'],['--belief','historical'])
q('all-rollout','Quartz production rollout',['memories/quartz-now','knowledge/quartz-guide','memories/quartz-old','memories/quartz-old.derived'],['--belief','all'])
for key,val in dict(user='alice',agent='worker',run='r2',channel='ops').items():
 q('scope-'+key,'Quartz production rollout',['memories/quartz-now'],['--filter',f'{key}={val}','--belief','current'],['memories/quartz-other','memories/quartz-old','memories/quartz-old.derived'])
q('empty','Quartz production rollout',[],['--filter','user=nobody'])
for name,rows in [('queries.jsonl',queries),('qrels.jsonl',qrels)]: (r/name).write_text(''.join(json.dumps(x)+'\n' for x in rows))
