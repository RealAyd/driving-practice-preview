import {createReadStream} from 'node:fs';
import {realpath,stat} from 'node:fs/promises';
import type {RequestListener} from 'node:http';
import {extname,resolve,sep} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {createGzip} from 'node:zlib';

const types:Record<string,string>={
  '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.json':'application/json',
  '.glb':'model/gltf-binary','.gltf':'model/gltf+json','.ktx2':'image/ktx2',
  '.wasm':'application/wasm','.mp3':'audio/mpeg','.ogg':'audio/ogg','.wav':'audio/wav',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp',
  '.svg':'image/svg+xml','.ico':'image/x-icon','.woff2':'font/woff2',
};

/** Serve only the built public directory; API requests retain their original body and headers. */
export function withStatic(api:RequestListener,directory:string):RequestListener{
  const root=resolve(directory);
  return async(req,res)=>{
    const raw=(req.url??'/').split('?')[0]!;
    if(raw==='/api'||raw.startsWith('/api/')||raw==='/healthz')return api(req,res);
    const fail=(status:number)=>{res.writeHead(status,{'Cache-Control':'no-store'});res.end()};
    if(req.method!=='GET'&&req.method!=='HEAD')return fail(405);
    res.setHeader('X-Content-Type-Options','nosniff');
    let path:string;
    try{path=decodeURIComponent(raw)}catch{return fail(400)}
    if(path.includes('\\')||path.includes('\0')||path.split('/').some(p=>p.startsWith('.'))||path==='/CNAME')return fail(404);
    const requested=resolve(root,'.'+(path==='/'?'/index.html':path));
    if(!requested.startsWith(root+sep))return fail(404);
    try{
      // Realpath also prevents a symlink inside the build from exposing server files.
      const [file,realRoot]=await Promise.all([realpath(requested),realpath(root)]);
      if(!file.startsWith(realRoot+sep))return fail(404);
      const info=await stat(file);
      if(!info.isFile())return fail(404);
      const ext=extname(file).toLowerCase();
      res.setHeader('Content-Type',types[ext]??'application/octet-stream');
      const hashed=path.startsWith('/assets/')&&/-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(path);
      res.setHeader('Cache-Control',ext==='.html'?'no-cache':hashed?'public, max-age=31536000, immutable':'public, max-age=3600');
      const compress=['.html','.js','.css','.json','.svg','.gltf'].includes(ext);
      if(compress)res.setHeader('Vary','Accept-Encoding');
      const gzip=compress&&(req.headers['accept-encoding']??'').split(',').some(part=>{
        const [name,...params]=part.trim().split(';');
        const quality=params.find(p=>p.trim().startsWith('q='));
        return name==='gzip'&&(!quality||Number(quality.trim().slice(2))>0);
      });
      if(gzip)res.setHeader('Content-Encoding','gzip');
      else res.setHeader('Content-Length',info.size);
      if(req.method==='HEAD'){res.end();return}
      if(gzip)await pipeline(createReadStream(file),createGzip(),res);
      else await pipeline(createReadStream(file),res);
    }catch{
      if(!res.headersSent&&!res.destroyed)fail(404);
      else res.destroy();
    }
  };
}
