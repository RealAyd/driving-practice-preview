// Staging only: keeps search engines from listing the staging copy. Every page says noindex (crawling stays allowed so
// they can read it), and robots.txt drops the sitemap. Usage: node hostless/noindex.mjs <dist directory>
import fs from 'node:fs';
import path from 'node:path';
const dir=process.argv[2];
if(!dir||!fs.existsSync(dir))throw new Error('Usage: node hostless/noindex.mjs <dist directory>');
const tag='<meta name="robots" content="noindex, nofollow">';
let pages=0;
const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){
  const p=path.join(d,e.name);
  if(e.isDirectory())walk(p);
  else if(e.name.endsWith('.html')){
    let html=fs.readFileSync(p,'utf8').replace(/<meta\s+name=["']robots["'][^>]*>\s*/gi,'');
    if(!/<head[^>]*>/i.test(html))throw new Error(`No <head> in ${p}`);
    fs.writeFileSync(p,html.replace(/<head[^>]*>/i,m=>`${m}\n${tag}`));pages++;
  }
}};
walk(dir);
fs.writeFileSync(path.join(dir,'robots.txt'),'User-agent: *\nAllow: /\n');
fs.rmSync(path.join(dir,'sitemap.xml'),{force:true});
console.log(`noindex on ${pages} pages; robots.txt without a sitemap`);
