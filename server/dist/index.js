import { withStatic } from './static.js';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { handler } from './http.js';
import { MongoStore } from './mongoStore.js';
import { OutboxMailer, OutboxPusher, fakeIdentities, fakeStripe, identityVerifier, ntfyPusher, resendMailer, stripeApi } from './providers.js';
import { Service } from './service.js';
import { MemoryStore } from './store.js';
const config = loadConfig();
// The production artifact must never run against a test Stripe key or fake providers.
if (config.devFakes || config.stripeMode !== 'live' || !/^(rk|sk)_live_/.test(config.stripeSecretKey ?? '')) {
    throw new Error('Production requires a live Stripe secret key and real providers');
}
const outbox = config.devFakes ? new OutboxMailer() : null;
const store = config.devFakes && !config.mongoUri ? new MemoryStore() : await MongoStore.connect(config.mongoUri);
const service = new Service(config, store, outbox ?? resendMailer(config), config.devFakes ? fakeIdentities : identityVerifier(config), config.devFakes ? fakeStripe(config) : stripeApi(config), config.devFakes ? new OutboxPusher() : config.supportPushUrl ? ntfyPusher : null);
// Support's worker: overdue reminders and the email/push outbox, every 20 seconds and as soon as something is queued.
let running = false;
const work = () => {
    if (running)
        return;
    running = true;
    service.support.tick().catch(e => console.error('Support worker:', e instanceof Error ? e.message : e)).finally(() => { running = false; });
};
service.support.onQueued = () => setImmediate(work);
setInterval(work, 20_000).unref();
createServer(withStatic(handler(service, outbox), fileURLToPath(new URL('../../dist-sim/', import.meta.url)))).listen(config.port, '0.0.0.0', () => {
    // (Names and modes only: never a key.)
    console.log(`Driving Practice API on :${config.port}; ${config.devFakes ? 'LOCAL FAKES (no real email, sign-in or payments)' : `Stripe ${config.stripeMode} mode`}; app ${config.appBaseUrl}`);
});
