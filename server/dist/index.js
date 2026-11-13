import { withStatic } from './static.js';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { handler as api } from './http.js';
import { MongoStore } from './mongoStore.js';
import { OutboxMailer, OutboxPusher, fakeIdentities, fakeStripe, identityVerifier, ntfyPusher, resendMailer, stripeApi } from './providers.js';
import { Service } from './service.js';
import { MemoryStore } from './store.js';
import { describe, notReady, retrying } from './startup.js';
const config = loadConfig();
// The production artifact must never run against a test Stripe key or fake providers.
if (config.devFakes || config.stripeMode !== 'live' || !/^(rk|sk)_live_/.test(config.stripeSecretKey ?? '')) {
    throw new Error('Production requires a live Stripe secret key and real providers');
}
// (Logged, not left to end the process: one stray failed promise is not worth an outage.)
process.on('unhandledRejection', e => console.error('Unhandled rejection:', describe(e)));
const outbox = config.devFakes ? new OutboxMailer() : null;
// The API, once the database is reached; until then requests are answered "starting" (notReady). The server listens
// straight away and keeps trying the database rather than exiting: a database restarting is an outage, not a crash loop.
let service = null, serve = null;
const handler = (_service, _outbox) => (req, res) => serve ? serve(req, res) : notReady(req, res);
void (async () => {
    const store = config.devFakes && !config.mongoUri ? new MemoryStore() : await retrying(() => MongoStore.connect(config.mongoUri), (attempt, e, wait) => console.error(`Database not reached (attempt ${attempt}): ${describe(e)}; trying again in ${wait} s`));
    const ready = new Service(config, store, outbox ?? resendMailer(config), config.devFakes ? fakeIdentities : identityVerifier(config), config.devFakes ? fakeStripe(config) : stripeApi(config), config.devFakes ? new OutboxPusher() : config.supportPushUrl ? ntfyPusher : null);
    service = ready;
    serve = api(ready, outbox);
    console.log('Database reached: the API is answering.');
    // Support's worker: overdue reminders and the email/push outbox, every 20 seconds and as soon as something is queued.
    let running = false;
    const work = () => {
        if (running)
            return;
        running = true;
        ready.support.tick().catch(e => console.error('Support worker:', describe(e))).finally(() => { running = false; });
    };
    ready.support.onQueued = () => setImmediate(work);
    setInterval(work, 20_000).unref();
})();
createServer(withStatic(handler(service, outbox), fileURLToPath(new URL('../../dist-sim/', import.meta.url)))).listen(config.port, '0.0.0.0', () => {
    // (Names and modes only: never a key.)
    console.log(`Driving Practice API on :${config.port}; ${config.devFakes ? 'LOCAL FAKES (no real email, sign-in or payments)' : `Stripe ${config.stripeMode} mode`}; app ${config.appBaseUrl}`);
});
