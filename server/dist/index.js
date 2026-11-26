import { withStatic } from './static.js';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { handler as api } from './http.js';
import { MongoStore } from './mongoStore.js';
import { OutboxMailer, OutboxPusher, fakeIdentities, fakeStripe, identityVerifier, ntfyPusher, resendMailer, stripeApi } from './providers.js';
import { Service } from './service.js';
import { MemoryStore } from './store.js';
import { Premium } from './premium.js';
import { MemoryPremiumStore, MongoPremiumStore } from './premiumStore.js';
import { MockPracticalApi } from './practical.js';
import { HttpPracticalApi } from './practicalClient.js';
import { describe, notReady, retrying } from './startup.js';
const config = loadConfig();
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
    // Practical Premium: only with PRACTICAL_PREMIUM=1 under local fakes (config.ts), against the mocked Practical.
    if (config.practicalPremium) {
        const premiumStore = store instanceof MongoStore ? new MongoPremiumStore(store.database) : new MemoryPremiumStore();
        if (premiumStore instanceof MongoPremiumStore)
            await premiumStore.indexes();
        const live = config.practicalPremium.live;
        let api;
        if (live)
            api = new HttpPracticalApi({ ...live, redirectUri: `${config.appBaseUrl}/?practical=done` });
        else {
            const mock = new MockPracticalApi();
            // (Invented requests, for the admin hub's table in local development; the mock is never used anywhere else.)
            mock.demand = [{ centre: 'Example Centre A', area: 'AB1', requests: 7, firstAt: '2026-11-01T09:00:00Z', lastAt: '2026-11-20T17:00:00Z' },
                { centre: 'Example Centre B', area: 'CD2', requests: 4, firstAt: '2026-11-10T09:00:00Z', lastAt: '2026-11-18T12:00:00Z' },
                { centre: 'Example Centre C', area: 'EF3', requests: 1, firstAt: '2026-11-15T09:00:00Z', lastAt: '2026-11-15T09:00:00Z' }];
            api = mock;
        }
        ready.premium = new Premium(premiumStore, api, config.practicalPremium);
        console.log(`Practical Premium on (${live ? 'live Practical' : 'local mock'}).`);
    }
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
