import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const source='source';
const commit=execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const entry=`${source}/server/src/index.ts`;
let text=fs.readFileSync(entry,'utf8');
if(!text.includes('withStatic(')){
  const old='createServer(handler(service,outbox)).listen(config.port,';
  if(!text.includes(old))throw new Error('Server entry changed; review same-origin integration before deploying');
  text="import {withStatic} from './static.js';\nimport {fileURLToPath} from 'node:url';\n"+text.replace(old,"createServer(withStatic(handler(service,outbox),fileURLToPath(new URL('../../dist-sim/',import.meta.url)))).listen(config.port,'0.0.0.0',");
  fs.writeFileSync(entry,text);
}
fs.copyFileSync('hostless/static.ts',`${source}/server/src/static.ts`);
fs.copyFileSync('hostless/static.test.ts',`${source}/server/test/static.test.ts`);
fs.writeFileSync('source-provenance.json',JSON.stringify({repository:'RealAyd/driving-simulator-vr',ref:process.env.SOURCE_REF,commit,builtAt:new Date().toISOString()},null,2));
