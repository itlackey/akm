import fs from 'node:fs';
import path from 'node:path';
const root=process.argv[2]!;
const sandbox=fs.mkdtempSync('/tmp/1198-cost-');
for(const key of ['AKM_DATA_DIR','AKM_STATE_DIR','AKM_CONFIG_DIR','AKM_CACHE_DIR']) process.env[key]=path.join(sandbox,key);
process.env.AKM_BUNDLE_DIR=path.join(sandbox,'stash');
fs.mkdirSync(process.env.AKM_BUNDLE_DIR,{recursive:true});
const {getDbPath}=await import(root+'/src/core/paths.ts');
const {openIndexDatabase,closeDatabase}=await import(root+'/src/storage/repositories/index-connection.ts');
const {upsertEntry}=await import(root+'/src/storage/repositories/index-entries-repository.ts');
const {upsertEmbedding}=await import(root+'/src/storage/repositories/index-vec-repository.ts');
const {deriveEntryProvenance}=await import(root+'/src/indexer/installations.ts');
const {setMeta}=await import(root+'/src/storage/repositories/index-meta-repository.ts');
const {_setEmbedderForTests}=await import(root+'/src/llm/embedder.ts');
const {searchLocal}=await import(root+'/src/indexer/search/db-search.ts');
const db=openIndexDatabase(getDbPath());
const vector=Array.from({length:1024},(_,i)=>i===0?1:0);
const indexStart=performance.now();
db.transaction(()=>{for(let n=0;n<10001;n++){
const name=`note-${String(n).padStart(5,'0')}`;const eligible=n===10000;
const entry={name,type:'memory',description:eligible?'quartz '+('background '.repeat(100)):'quartz quartz',content:('independent fact '+n+' ').repeat(180),scope:{user:eligible?'alice':'bob'}};
const id=upsertEntry(db,path.join(process.env.AKM_BUNDLE_DIR!,name+'.md'),entry,deriveEntryProvenance({bundleId:'stash',componentId:'stash',adapterId:'akm'},'memory',name));
upsertEmbedding(db,id,eligible?[0.6,0.8,...new Array(1022).fill(0)]:vector);
}})();
setMeta(db,'stashDir',process.env.AKM_BUNDLE_DIR!);closeDatabase(db);
const indexMs=+(performance.now()-indexStart).toFixed(3);
_setEmbedderForTests({embed:async()=>vector});
const results:any[]=[];
for(const mode of ['off','auto'])for(const user of [undefined,'alice','nobody']){
const measurements=[];let last;
for(let repeat=0;repeat<4;repeat++){
const started=performance.now();last=await searchLocal({query:'quartz',searchType:'any',limit:1,stashDir:process.env.AKM_BUNDLE_DIR!,sources:[{path:process.env.AKM_BUNDLE_DIR!}],config:{defaultBundle:'stash',semanticSearchMode:mode as any},filters:user?{user}:undefined});
measurements.push(+(performance.now()-started).toFixed(3));}
results.push({mode,user:user??'unfiltered',coldMs:measurements[0],warmMs:measurements.slice(1),hits:last.hits.map((h:any)=>h.name),actualMode:last.mode});}
console.log(JSON.stringify({root,indexMs,rss:process.memoryUsage().rss,cases:results},null,2));
fs.rmSync(sandbox,{recursive:true,force:true});
