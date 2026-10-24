import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require=createRequire(resolve('source/package.json'));
const {MongoClient}=require('mongodb');
const projectId='6ac5392e4b1c266c8f3f9f1b';
const app='dp-sim-staging',database='dp-sim-staging',logicalDb='dp_sim_staging';
const origin=`https://${app}.hostless.app`;
// The address people use. APP_BASE_URL (sign-in links, the allowed origin for posts) is set to it once it serves this
// app over HTTPS; until its DNS resolves, the platform address keeps sign-in working.
const customOrigin='https://staging.drivingpractice.live';
async function publicOrigin(){
  try{
    const r=await fetch(customOrigin+'/healthz',{signal:AbortSignal.timeout(10000)});
    if(r.ok&&(await r.json()).ok===true)return customOrigin;
  }catch{}
  console.log(`${customOrigin} is not serving this app yet (DNS or certificate pending): APP_BASE_URL stays ${origin}`);
  return origin;
}
const events=['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','charge.refunded','charge.dispute.created'];
const pause=ms=>new Promise(r=>setTimeout(r,ms));

// Never print API response bodies: validation errors can echo credential values.
async function hostless(path,method='GET',body){
  const r=await fetch('https://api.hostless.cloud/v1'+path,{method,headers:{Authorization:`Bearer ${process.env.HOSTLESS_TOKEN}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  if(r.status===404&&method==='GET')return null;
  if(!r.ok)throw new Error(`Hostless ${method} ${path.split('?')[0]}: HTTP ${r.status}`);
  return r.status===204?null:r.json();
}
async function stripe(path,method='GET',body){
  const r=await fetch('https://api.stripe.com/v1'+path,{method,headers:{Authorization:`Bearer ${process.env.STRIPE_SECRET_KEY}`,'Content-Type':'application/x-www-form-urlencoded'},...(body?{body:body.toString()}:{})});
  if(!r.ok)throw new Error(`Stripe ${method} ${path.split('?')[0]}: HTTP ${r.status}. Webhook management requires separate permission; supply this staging endpoint's STRIPE_WEBHOOK_SECRET if managed in the dashboard.`);
  return r.json();
}
async function main(){
  if(!/^(sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY??''))throw new Error('STRIPE_SECRET_KEY must be a Stripe TEST key');
  if(!/^[a-f0-9]{40}$/.test(process.env.RELEASE_COMMIT??''))throw new Error('Missing full release commit');
  const existing=await hostless(`/apps/${app}`);
  if(existing&&(existing.projectId!==projectId||existing.gitRepo!=='RealAyd/driving-practice-preview'))throw new Error('Staging app ownership/repository mismatch');
  const current=existing?await hostless(`/apps/${app}/environment-variables`):[];
  const vars=Array.isArray(current)?current:current.variables??[];
  const names=new Set(vars.map(v=>v.name));
  const updates=new Map();
  const appBaseUrl=await publicOrigin();
  const webhookUrl=`${appBaseUrl}/api/stripe/webhook`;
  let webhookSecret=process.env.STRIPE_WEBHOOK_SECRET;
  if(!webhookSecret&&!names.has('STRIPE_WEBHOOK_SECRET')){
    const endpoints=await stripe('/webhook_endpoints?limit=100');
    if(endpoints.data.some(e=>e.url===webhookUrl))throw new Error(`Staging Stripe endpoint already exists. Save its signing secret as STRIPE_WEBHOOK_SECRET; do not replace unrelated endpoints. URL: ${webhookUrl}`);
    if(endpoints.has_more)throw new Error('Stripe webhook list exceeds one page; inspect endpoints before creating another');
    const form=new URLSearchParams({url:webhookUrl,description:'Driving Practice simulator staging (TEST)'});
    events.forEach(e=>form.append('enabled_events[]',e));
    const endpoint=await stripe('/webhook_endpoints','POST',form);
    if(endpoint.livemode||!endpoint.secret)throw new Error('Stripe did not create a TEST webhook with a signing secret');
    webhookSecret=endpoint.secret;
    console.log(`Created TEST webhook: ${webhookUrl}`);
  }
  if(webhookSecret)updates.set('STRIPE_WEBHOOK_SECRET',webhookSecret);
  if(!names.has('MONGODB_URI')){
    let details;
    for(let i=0;i<30;i++){
      details=await hostless(`/databases/${database}/details`);
      if(details?.details?.status==='RUNNING')break;
      if(i===29)throw new Error('Staging MongoDB not ready after five minutes');
      await pause(10000);
    }
    if(details.details.name!==database)throw new Error('Unexpected database');
    const c=details.connection;
    if(!c.connectionString)throw new Error('Hostless database details did not supply a connection string');
    const adminUri=new URL(c.connectionString);
    adminUri.searchParams.set('tls','true');
    const client=new MongoClient(adminUri.toString(),{serverSelectionTimeoutMS:30000});
    const username='dp_sim_app',password=randomBytes(36).toString('hex');
    try{
      await client.connect();
      const db=client.db(logicalDb);
      const users=await db.command({usersInfo:username});
      const command=users.users.length?'updateUser':'createUser';
      await db.command({[command]:username,pwd:password,roles:[{role:'readWrite',db:logicalDb}]});
    }catch{throw new Error('Could not provision the scoped staging MongoDB user; credentials suppressed')}
    finally{await client.close()}
    const scoped=new URL(adminUri);
    scoped.username=username;scoped.password=password;scoped.pathname='/'+logicalDb;
    scoped.searchParams.set('authSource',logicalDb);
    const check=new MongoClient(scoped.toString(),{serverSelectionTimeoutMS:30000});
    try{await check.connect();await check.db().command({ping:1})}
    catch{throw new Error('Scoped staging MongoDB credential verification failed; credentials suppressed')}
    finally{await check.close()}
    updates.set('MONGODB_URI',scoped.toString());
  }
  if(!names.has('SESSION_SECRET'))updates.set('SESSION_SECRET',randomBytes(48).toString('base64'));
  for(const key of ['STRIPE_SECRET_KEY','RESEND_API_KEY','GOOGLE_CLIENT_ID','APPLE_SERVICES_ID'])if(process.env[key])updates.set(key,process.env[key]);
  for(const [key,value] of Object.entries({NODE_ENV:'production',APP_BASE_URL:appBaseUrl,EMAIL_FROM:'Driving Practice <support@drivingpractice.live>',EMAIL_REPLY_TO:'support.drivingpractice@gmail.com',ADMIN_EMAILS:'dosumuaybamo1@gmail.com'}))updates.set(key,value);
  const environmentVariables=[...vars.filter(v=>!updates.has(v.name)).map(v=>({name:v.name,keepExistingValue:true})),...[...updates].map(([name,value])=>({name,value}))];
  if(!existing){
    await hostless('/apps','POST',{name:app,projectId,gitPlatform:'Github',gitRepo:'RealAyd/driving-practice-preview',gitBranch:'hostless-staging-release',gitCommitHash:process.env.RELEASE_COMMIT,containerPort:8000,dockerFilePath:'Dockerfile',buildSystem:'docker',autoDeployOnPush:false,environmentVariables});
  }else{
    await hostless(`/apps/${app}?deploy=false`,'PATCH',{gitBranch:'hostless-staging-release',gitCommitHash:process.env.RELEASE_COMMIT,autoDeployOnPush:false,environmentVariables});
    await hostless(`/apps/${app}/deployments/new`,'POST',{gitCommitHash:process.env.RELEASE_COMMIT});
  }
  console.log('Configured environment variable names: '+environmentVariables.map(v=>v.name).sort().join(', '));
  console.log(`Staging deployment requested: ${origin} (APP_BASE_URL ${appBaseUrl})`);
  for(let i=0;i<90;i++){
    try{
      const info=await fetch(origin+'/build-info.json',{signal:AbortSignal.timeout(10000)});
      const gate=await fetch(origin+'/access.json',{signal:AbortSignal.timeout(10000)});
      const health=await fetch(origin+'/healthz',{signal:AbortSignal.timeout(10000)});
      const config=await fetch(origin+'/api/config',{signal:AbortSignal.timeout(10000)});
      const local=require('../source-provenance.json');
      if(info.ok&&gate.ok&&health.ok&&config.ok&&(await info.json()).commit===local.commit&&(await gate.json()).gate===true){
        const body=await config.json();
        if(body.devCheckout===true||body.gate!==true||!Array.isArray(body.packs))throw new Error('Unexpected staging API configuration');
        console.log(`Verified source commit ${local.commit}, access gate, health and API config (${body.packs.length} packs).`);
        return;
      }
    }catch{}
    if(i%6===0)console.log('Waiting for the staging release to become healthy');
    await pause(10000);
  }
  throw new Error('Staging health/provenance verification timed out; inspect Hostless deployment logs');
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Deployment failed; details suppressed');process.exitCode=1});
