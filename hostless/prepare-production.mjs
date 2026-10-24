import './prepare.mjs';
import fs from 'node:fs';
const packs=JSON.parse(fs.readFileSync('source/server/packs.json','utf8')).packs;
if(packs.length!==4||new Set(packs.map(p=>p.links.live)).size!==4)throw new Error('Expected four distinct live Payment Links');
for(const pack of packs){
  const url=new URL(pack.links.live);
  if(url.origin!=='https://buy.stripe.com'||url.pathname.startsWith('/test_'))throw new Error('Missing live Payment Link for '+pack.id);
}
const file='source/server/src/index.ts';
const text=fs.readFileSync(file,'utf8');
const anchor='const config=loadConfig();';
if(!text.includes(anchor))throw new Error('Review production startup guard for changed server entry');
fs.writeFileSync(file,text.replace(anchor,anchor+`
// The production artifact must never run against a test Stripe key or fake providers.
if(config.devFakes||config.stripeMode!=='live'||! /^(rk|sk)_live_/.test(config.stripeSecretKey??'')){
  throw new Error('Production requires a live Stripe secret key and real providers');
}
`));
