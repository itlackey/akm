import fs from "node:fs";
import path from "node:path";
const REPO = import.meta.dir;
const TESTS = path.join(REPO, "tests");
const SKIP = JSON.parse(fs.readFileSync(path.join(REPO, "scripts/codemod-ref-literals.skip.json"), "utf8")).skip.map((p:string)=>path.normalize(p));
const skipSet = new Set(SKIP);
const TYPES = ["skill","command","agent","knowledge","workflow","script","memory","env","secret","lesson","task","session","fact"];
const TOKEN = new RegExp(`(?<![A-Za-z])(?<!\\$\\{)(?:${TYPES.join("|")}):[A-Za-z0-9]`,"g");
const EXCL = ["tests/fixtures/goldens/","tests/migrate/legacy/","tests/_helpers/","tests/_fixtures/"];
const files:string[]=[];
function walk(d:string){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name);if(e.isDirectory())walk(f);else if(e.isFile()&&(e.name.endsWith(".ts")||e.name.endsWith(".json")))files.push(f);}}
walk(TESTS);
const target = process.argv[2];
for(const abs of files.sort()){
  const rel=path.relative(REPO,abs).replace(/\\/g,"/");
  if(EXCL.some(d=>rel.startsWith(d))||skipSet.has(path.normalize(rel)))continue;
  if(target && !rel.includes(target))continue;
  const lines=fs.readFileSync(abs,"utf8").split("\n");
  lines.forEach((ln,i)=>{const m=ln.match(TOKEN);if(m){console.log(`${rel}:${i+1}: ${ln.trim().slice(0,160)}`);}});
}
