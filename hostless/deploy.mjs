import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require=createRequire(resolve('source/package.json'));
const {MongoClient}=require('mongodb');
const projectId='6ac5392e4b1c266c8f3f9f1b';
const app='dp-sim-staging',database='dp-sim-staging',logicalDb='dp_sim_staging';
const origin=`https://${app}.hostless.app`;
// DNS and HTTPS verified on 24 October 2026. Keep the canonical origin stable:
// a runner's cached negative DNS answer must not switch authentication back.
const customOrigin='https://staging.drivingpractice.live';
async function publicOrigin(){return customOrigin}
const events=['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','charge.refunded','charge.dispute.created'];
const pause=ms=>new Promise(r=>setTimeout(r,ms));

// Values that must never be printed: the secrets passed in, and those generated here (added as they are made).
const sensitive=new Set(['HOSTLESS_TOKEN','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','RESEND_API_KEY'].map(k=>process.env[k]).filter(v=>v&&v.length>=8));
/** An API error message with every known secret, and anything shaped like a credential or connection string, masked. */
function redact(text){
  let t=String(text);
  for(const v of sensitive)t=t.split(v).join('***');
  return t.replace(/\b(sk|rk|pk|whsec|re|hlk)_[A-Za-z0-9_]{6,}/g,'***').replace(/mongodb(\+srv)?:\/\/\S+/g,'mongodb://***').replace(/[A-Za-z0-9+\/=_-]{32,}/g,'***').slice(0,600);
}
async function hostless(path,method='GET',body){
  const r=await fetch('https://api.hostless.cloud/v1'+path,{method,headers:{Authorization:`Bearer ${process.env.HOSTLESS_TOKEN}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  if(r.status===404&&method==='GET')return null;
  // (The error text is shown redacted: validation errors name the field at fault, and could echo a value.)
  if(!r.ok)throw new Error(`Hostless ${method} ${path.split('?')[0]}: HTTP ${r.status}: ${redact(await r.text().catch(()=>''))}`);
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
    sensitive.add(endpoint.secret);
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
    sensitive.add(scoped.toString());sensitive.add(password);
    updates.set('MONGODB_URI',scoped.toString());
  }
  if(!names.has('SESSION_SECRET')){const s=randomBytes(48).toString('base64');sensitive.add(s);updates.set('SESSION_SECRET',s)}
  for(const key of ['STRIPE_SECRET_KEY','RESEND_API_KEY','GOOGLE_CLIENT_ID','APPLE_SERVICES_ID'])if(process.env[key])updates.set(key,process.env[key]);
  for(const [key,value] of Object.entries({NODE_ENV:'production',APP_BASE_URL:appBaseUrl,EMAIL_FROM:'Driving Practice <support@drivingpractice.live>',EMAIL_REPLY_TO:'support.drivingpractice@gmail.com',ADMIN_EMAILS:'dosumuaybamo1@gmail.com'}))updates.set(key,value);
  const environmentVariables=[...vars.filter(v=>!updates.has(v.name)).map(v=>({name:v.name,keepExistingValue:true})),...[...updates].map(([name,value])=>({name,value}))];
  if(!existing){
    await hostless('/apps','POST',{name:app,projectId,gitPlatform:'Github',gitRepo:'RealAyd/driving-practice-preview',gitBranch:'hostless-staging-release',gitCommitHash:process.env.RELEASE_COMMIT,containerPort:8000,dockerFilePath:'Dockerfile',buildSystem:'docker',autoDeployOnPush:false,environmentVariables});
  }else{
    // Saving the settings with deployment on releases the head of the release branch: the commit this run just pushed
    // (runs are serialized). The check below confirms the served build is this source commit.
    await hostless(`/apps/${app}?deploy=true`,'PATCH',{gitBranch:'hostless-staging-release',autoDeployOnPush:false,environmentVariables});
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
      const served=info.ok?await info.json():null;
      if(info.ok&&gate.ok&&health.ok&&config.ok&&served?.commit===local.commit&&served?.builtAt===local.builtAt&&(await gate.json()).gate===true){
        const body=await config.json();
        if(body.devCheckout===true||body.gate!==true||body.appleRedirect!==`${appBaseUrl}/api/auth/apple/callback`||!Array.isArray(body.packs))throw new Error('Unexpected staging API configuration');
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
