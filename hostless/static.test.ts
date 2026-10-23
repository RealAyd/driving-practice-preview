import {mkdtemp,writeFile,mkdir,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withStatic} from '../src/static.js';

let directory:string,server:Server,base:string;
beforeAll(async()=>{
  directory=await mkdtemp(join(tmpdir(),'sim-static-'));
  await mkdir(join(directory,'assets'));
  for(const [name,value] of Object.entries({'index.html':'<h1>Simulator</h1>','assets/main-abcdefgh.js':'console.log(1)','assets/model.glb':'model','texture.ktx2':'texture','engine.wasm':'wasm','CNAME':'production.example'}))await writeFile(join(directory,name),value);
  await symlink('/etc/passwd',join(directory,'outside.txt'));
  server=createServer(withStatic(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    res.setHeader('Cache-Control','no-store');res.end(body||'api');
  },directory));
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async()=>{await new Promise<void>(r=>server.close(()=>r()));await rm(directory,{recursive:true,force:true})});
it('serves HTML without long caching and compresses negotiated content',async()=>{
  const r=await fetch(base+'/',{headers:{'Accept-Encoding':'gzip'}});
  expect(r.headers.get('cache-control')).toBe('no-cache');
  expect(r.headers.get('content-encoding')).toBe('gzip');
  expect(await r.text()).toBe('<h1>Simulator</h1>');
});
it('caches only hashed assets immutably and assigns model, texture and wasm MIME types',async()=>{
  expect((await fetch(base+'/assets/main-abcdefgh.js')).headers.get('cache-control')).toContain('immutable');
  for(const [path,type] of [['/assets/model.glb','model/gltf-binary'],['/texture.ktx2','image/ktx2'],['/engine.wasm','application/wasm']]){
    const r=await fetch(base+path);expect(r.headers.get('content-type')).toBe(type);
    expect(r.headers.get('cache-control')).toBe('public, max-age=3600');
  }
});
it('preserves raw webhook bodies and bypasses static handling for the API and health check',async()=>{
  const raw=' { "event": true } ';
  const r=await fetch(base+'/api/stripe/webhook',{method:'POST',body:raw});
  expect(await r.text()).toBe(raw);expect(r.headers.get('cache-control')).toBe('no-store');
  expect(await (await fetch(base+'/healthz')).text()).toBe('api');
});
it('blocks hidden files, symlink escapes, encoded traversal and CNAME; missing assets stay 404',async()=>{
  for(const path of ['/outside.txt','/.env','/%2e%2e%2fetc/passwd','/CNAME','/missing.js'])expect((await fetch(base+path)).status).toBe(404);
});
it('supports HEAD and honours gzip refusal',async()=>{
  const r=await fetch(base+'/',{method:'HEAD',headers:{'Accept-Encoding':'gzip;q=0'}});
  expect(r.status).toBe(200);expect(r.headers.get('content-encoding')).toBeNull();expect(await r.text()).toBe('');
});
