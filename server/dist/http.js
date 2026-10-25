import { createHmac, timingSafeEqual } from 'node:crypto';
import { Admin } from './admin.js';
import { MAX_SCREENSHOTS, MAX_SCREENSHOT_BYTES } from './support.js';
/** Signed-in cookie: account id and expiry, signed with SESSION_SECRET. HttpOnly; Secure when served over HTTPS. */
const COOKIE = 'dp_session', COOKIE_DAYS = 60;
/** The device's free try (signed the same way; its id, not an account): kept a year. */
const TRIAL_COOKIE = 'dp_trial', TRIAL_DAYS = 365;
/** The admin hub needs a sign-in from the last this many hours (the learner's cookie lasts COOKIE_DAYS). */
export const ADMIN_SIGNIN_HOURS = 12;
const b64 = (s) => Buffer.from(s).toString('base64url');
export function sign(secret, accountId, now = Date.now(), days = COOKIE_DAYS) {
    const body = b64(JSON.stringify({ a: accountId, e: now + days * 86400_000 }));
    return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
export function readSession(secret, value, now = Date.now()) {
    return readSessionInfo(secret, value, now)?.accountId ?? null;
}
/** The signed-in account and when that sign-in happened. */
function readSessionInfo(secret, value, now = Date.now()) {
    if (!value)
        return null;
    const [body, mac] = value.split('.');
    if (!body || !mac)
        return null;
    const want = createHmac('sha256', secret).update(body).digest('base64url');
    if (mac.length !== want.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(want)))
        return null;
    try {
        const { a, e } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        return typeof a === 'string' && typeof e === 'number' && e > now ? { accountId: a, signedInAt: e - COOKIE_DAYS * 86400_000 } : null;
    }
    catch {
        return null;
    }
}
const cookies = (req) => Object.fromEntries((req.headers.cookie ?? '').split(';').map(c => c.trim().split('=')).filter(p => p.length === 2).map(([k, v]) => [k, decodeURIComponent(v)]));
class HttpError extends Error {
    status;
    code;
    constructor(status, code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}
async function body(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
        size += c.length;
        if (size > limit)
            throw new HttpError(413, 'too-large');
        chunks.push(c);
    }
    return Buffer.concat(chunks);
}
async function json(req) {
    if (!(req.headers['content-type'] ?? '').startsWith('application/json'))
        throw new HttpError(415, 'json-only');
    try {
        const v = JSON.parse((await body(req, 16_384)).toString('utf8'));
        return v && typeof v === 'object' ? v : {};
    }
    catch (e) {
        if (e instanceof HttpError)
            throw e;
        throw new HttpError(400, 'bad-json');
    }
}
const str = (v, max = 500) => typeof v === 'string' && v.length <= max ? v : null;
/** The request handler: everything under /api, plus /healthz. */
export function handler(service, outbox) {
    const { config } = service;
    const admin = new Admin(config, service.store);
    const { support } = service;
    /** An admin signed in recently enough for the hub (null otherwise). */
    const hubAdmin = async (session) => session && Date.now() - session.signedInAt <= ADMIN_SIGNIN_HOURS * 3600_000 ? admin.adminEmail(session.accountId) : null;
    const secure = config.appBaseUrl.startsWith('https://');
    const origin = new URL(config.appBaseUrl).origin;
    const setSession = (res, accountId) => res.setHeader('Set-Cookie', `${COOKIE}=${accountId ? sign(config.sessionSecret, accountId) : ''}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=${accountId ? COOKIE_DAYS * 86400 : 0}`);
    const setTrial = (res, trialId) => res.appendHeader('Set-Cookie', `${TRIAL_COOKIE}=${sign(config.sessionSecret, `trial:${trialId}`, Date.now(), TRIAL_DAYS)}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=${TRIAL_DAYS * 86400}`);
    const send = (res, status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
    };
    const redirect = (res, to) => { res.writeHead(303, { Location: to, 'Cache-Control': 'no-store' }); res.end(); };
    const ipOf = (req) => String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || '?';
    return async (req, res) => {
        const url = new URL(req.url ?? '/', config.appBaseUrl);
        const path = url.pathname, method = req.method ?? 'GET';
        res.setHeader('X-Content-Type-Options', 'nosniff');
        try {
            if (path === '/healthz')
                return send(res, 200, { ok: true });
            // Posts from other sites are refused (Stripe's webhook and Apple's return post are checked their own way).
            const crossSite = method === 'POST' && req.headers.origin && req.headers.origin !== origin && path !== '/api/stripe/webhook' && path !== '/api/auth/apple/callback';
            if (crossSite)
                throw new HttpError(403, 'cross-site');
            const session = readSessionInfo(config.sessionSecret, cookies(req)[COOKIE]);
            const accountId = session?.accountId ?? null;
            const signedIn = () => { if (!accountId)
                throw new HttpError(401, 'sign-in'); return accountId; };
            const trialCookie = readSession(config.sessionSecret, cookies(req)[TRIAL_COOKIE]);
            const trialId = trialCookie?.startsWith('trial:') ? trialCookie.slice(6) : null;
            if (method === 'GET' && path === '/api/config')
                return send(res, 200, {
                    gate: true, googleClientId: config.googleClientId, appleServicesId: config.appleServicesId, packs: service.packs(), devCheckout: config.devFakes,
                    appleRedirect: `${config.appBaseUrl}/api/auth/apple/callback`
                });
            if (method === 'GET' && path === '/api/me') {
                const me = accountId ? await service.me(accountId) : null;
                if (accountId && !me)
                    setSession(res, null);
                // (The device's free try: what is left of it, signed in or not.)
                const trial = await service.trialLeft(trialId);
                return send(res, 200, me ? { signedIn: true, ...me, trial } : { signedIn: false, trial });
            }
            if (method === 'POST' && path === '/api/auth/email') {
                const b = await json(req);
                const r = await service.requestEmailCode(str(b['email'], 254) ?? '', ipOf(req), str(b['ref'], 20) ?? undefined);
                return send(res, r === 'sent' ? 200 : r === 'invalid' ? 400 : 429, { result: r });
            }
            if (method === 'POST' && path === '/api/auth/email/code') {
                const b = await json(req);
                const a = await service.verifyEmailCode(str(b['email'], 254) ?? '', str(b['code'], 12) ?? '');
                if (!a)
                    return send(res, 400, { error: 'wrong-or-expired' });
                setSession(res, a.id);
                return send(res, 200, { ok: true });
            }
            if (method === 'GET' && path === '/api/auth/email/verify') {
                const a = await service.verifyEmailToken(url.searchParams.get('token') ?? '');
                if (!a)
                    return redirect(res, `${config.appBaseUrl}/?signin=expired`);
                setSession(res, a.id);
                return redirect(res, `${config.appBaseUrl}/?signin=done`);
            }
            if (method === 'POST' && (path === '/api/auth/google' || path === '/api/auth/apple')) {
                const b = await json(req);
                const credential = str(b['credential'], 8192);
                if (!credential)
                    throw new HttpError(400, 'credential');
                const a = await service.signInWith(path.endsWith('google') ? 'google' : 'apple', credential, str(b['ref'], 20) ?? undefined).catch(() => null);
                if (!a)
                    return send(res, 401, { error: 'not-verified' });
                setSession(res, a.id);
                return send(res, 200, { ok: true });
            }
            // Apple's own page posts back here when the popup cannot be used (form post with id_token; `state` carries the referral).
            if (method === 'POST' && path === '/api/auth/apple/callback') {
                const form = new URLSearchParams((await body(req, 16_384)).toString('utf8'));
                const token = form.get('id_token');
                const a = token ? await service.signInWith('apple', token, form.get('state')?.replace(/^ref:/, '') || undefined).catch(() => null) : null;
                if (!a)
                    return redirect(res, `${config.appBaseUrl}/?signin=failed`);
                setSession(res, a.id);
                return redirect(res, `${config.appBaseUrl}/?signin=done`);
            }
            if (method === 'POST' && path === '/api/auth/logout') {
                setSession(res, null);
                return send(res, 200, { ok: true });
            }
            // The address to pay for a pack, made by the server for the signed-in account (never assembled by the browser).
            if (method === 'POST' && path === '/api/checkout') {
                const id = signedIn(), b = await json(req);
                const r = await service.checkoutUrl(id, str(b['pack'], 40) ?? '');
                return 'url' in r ? send(res, 200, r) : send(res, r.error === 'starter-bought' ? 409 : 400, r);
            }
            // Back from paying: credit anything Stripe has that the webhook has not delivered yet.
            if (method === 'POST' && path === '/api/checkout/reconcile') {
                const r = await service.reconcile(signedIn());
                return send(res, 'error' in r ? (r.error === 'slow-down' ? 429 : r.error === 'not-found' ? 404 : 503) : 200, r);
            }
            // A drive: an account's sessions; otherwise (signed out, or none left) the device's free try.
            if (method === 'POST' && path === '/api/drives') {
                const b = await json(req), kind = str(b['kind'], 40) ?? 'drive', scenario = str(b['scenario'], 80) ?? '';
                if (accountId) {
                    const r = await service.startDrive(accountId, kind, scenario);
                    if (r.ok)
                        return send(res, 200, { driveId: r.drive.id, balance: r.balance });
                }
                const t = await service.startTrialDrive(trialId, ipOf(req), kind, scenario);
                if (t.trialId && t.trialId !== trialId)
                    setTrial(res, t.trialId);
                if (t.start.ok)
                    return send(res, 200, { driveId: t.start.drive.id, balance: 0, trial: true });
                return send(res, t.start.reason === 'slow-down' ? 429 : 402, { error: accountId && t.start.reason === 'trial-used' ? 'no-sessions' : t.start.reason });
            }
            const drive = /^\/api\/drives\/([\w-]{8,64})\/(loaded|failed|completed)$/.exec(path);
            if (method === 'POST' && drive) {
                const status = drive[2];
                const ok = (!!accountId && await service.driveStatus(accountId, drive[1], status)) || (!!trialId && await service.driveStatus(`trial:${trialId}`, drive[1], status));
                return send(res, ok ? 200 : 404, { ok });
            }
            if (method === 'POST' && path === '/api/stripe/webhook') {
                const raw = await body(req, 1_000_000);
                const r = await service.stripeWebhook(raw, String(req.headers['stripe-signature'] ?? ''));
                return send(res, r === 'ok' ? 200 : 400, { received: r === 'ok' });
            }
            // ---- Support (/support.html): signed in, or signed out with the link from the customer's email ----
            if (method === 'GET' && path === '/api/support/config')
                return send(res, 200, { categories: support.categories(), maxScreenshots: MAX_SCREENSHOTS, maxScreenshotBytes: MAX_SCREENSHOT_BYTES });
            if (method === 'POST' && path === '/api/support/attachments') {
                // (Raw image bytes: only from this site's own pages.)
                if (req.headers.origin !== origin)
                    throw new HttpError(403, 'cross-site');
                const r = await support.upload(await body(req, MAX_SCREENSHOT_BYTES + 1).catch(e => { if (e instanceof HttpError && e.status === 413)
                    throw new HttpError(413, 'size'); throw e; }), ipOf(req));
                return 'error' in r ? send(res, r.error === 'slow-down' ? 429 : r.error === 'size' ? 413 : 415, r) : send(res, 200, r);
            }
            if (method === 'POST' && path === '/api/support/tickets') {
                const r = await support.create(await json(req), { accountId, ip: ipOf(req) });
                return 'error' in r ? send(res, r.error === 'slow-down' ? 429 : 400, r) : send(res, 200, r);
            }
            if (method === 'GET' && path === '/api/support/tickets')
                return send(res, 200, { tickets: await support.mine(signedIn()) });
            const mine = /^\/api\/support\/tickets\/([\w-]{8,64})(\/messages)?$/.exec(path);
            if (mine && method === 'GET' && !mine[2]) {
                const t = await support.customerView(mine[1], { accountId, token: url.searchParams.get('t') });
                return t ? send(res, 200, t) : send(res, 404, { error: 'not-found' });
            }
            if (mine && method === 'POST' && mine[2]) {
                const b = await json(req);
                const r = await support.customerReply(mine[1], { accountId, token: str(b['t'], 100) }, b);
                return 'error' in r ? send(res, r.error === 'not-found' ? 404 : r.error === 'slow-down' ? 429 : 400, r) : send(res, 200, r);
            }
            const shot = /^\/api\/support\/attachments\/([\w-]{8,64})$/.exec(path);
            if (shot && method === 'GET') {
                const a = await support.attachment(shot[1], { accountId, token: url.searchParams.get('t'), admin: !!await hubAdmin(session) });
                if (!a)
                    return send(res, 404, { error: 'not-found' });
                // Served as the image it was checked to be, never as a page.
                res.writeHead(200, { 'Content-Type': a.type, 'Content-Length': a.size, 'Content-Disposition': `inline; filename="screenshot.${a.type.split('/')[1]}"`,
                    'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" });
                return res.end(a.data);
            }
            // ---- The admin hub (/admin.html): ADMIN_EMAILS only, signed in within the last ADMIN_SIGNIN_HOURS ----
            if (path.startsWith('/api/admin/')) {
                const by = await admin.adminEmail(signedIn());
                if (!by)
                    throw new HttpError(403, 'not-admin');
                if (Date.now() - session.signedInAt > ADMIN_SIGNIN_HOURS * 3600_000)
                    throw new HttpError(401, 'reauth');
                // Changes come only from this site's own page (a missing Origin is refused too).
                if (method === 'POST' && req.headers.origin !== origin)
                    throw new HttpError(403, 'cross-site');
                res.setHeader('X-Robots-Tag', 'noindex');
                if (method === 'GET' && path === '/api/admin/overview')
                    return send(res, 200, { ...await admin.overview(), support: await support.counts(),
                        webhooks: { ...service.webhookStats, mode: config.stripeMode } });
                // Support: the queue, a request, and what an admin can do with it.
                if (method === 'GET' && path === '/api/admin/support')
                    return send(res, 200, await support.queue(url.searchParams.get('state') ?? 'open'));
                const ticket = /^\/api\/admin\/support\/([\w-]{8,64})(?:\/(acknowledge|messages|state|priority))?$/.exec(path);
                if (ticket && method === 'GET' && !ticket[2]) {
                    const t = await support.adminView(ticket[1]);
                    return t ? send(res, 200, t) : send(res, 404, { error: 'not-found' });
                }
                if (ticket && method === 'POST' && ticket[2]) {
                    const id = ticket[1], b = await json(req);
                    if (ticket[2] === 'messages') {
                        const r = await support.adminMessage(id, by, b);
                        return 'error' in r ? send(res, r.error === 'not-found' ? 404 : 400, r) : send(res, 200, r);
                    }
                    const ok = ticket[2] === 'acknowledge' ? await support.acknowledge(id, by) : ticket[2] === 'state' ? await support.setState(id, by, b['state']) : await support.setPriority(id, by, b['priority']);
                    return send(res, ok ? 200 : 400, { ok });
                }
                if (method === 'GET' && path === '/api/admin/notifications/failed')
                    return send(res, 200, await support.failedNotifications());
                const retry = /^\/api\/admin\/notifications\/([\w-]{8,64})\/retry$/.exec(path);
                if (retry && method === 'POST')
                    return send(res, await support.retry(retry[1]) ? 200 : 404, {});
                if (method === 'GET' && path === '/api/admin/customers')
                    return send(res, 200, await admin.customers(url.searchParams.get('q') ?? ''));
                const customer = /^\/api\/admin\/customers\/([\w-]{8,64})(\/adjust)?$/.exec(path);
                if (customer && method === 'GET' && !customer[2]) {
                    const c = await admin.customer(customer[1]);
                    return c ? send(res, 200, c) : send(res, 404, { error: 'not-found' });
                }
                if (customer && method === 'POST' && customer[2]) {
                    const b = await json(req);
                    const r = await admin.adjust(by, customer[1], { sessions: b['sessions'], pot: b['pot'], reason: b['reason'], requestId: b['requestId'] });
                    if ('error' in r)
                        return send(res, r.error === 'not-found' ? 404 : r.error === 'insufficient' ? 409 : 400, r);
                    console.log(`Admin adjustment: ${r.result} ${String(b['sessions'])} on ${customer[1]}`);
                    return send(res, 200, r);
                }
                if (method === 'GET' && path === '/api/admin/payments') {
                    const p = await admin.payments(url.searchParams.get('from'), url.searchParams.get('to'));
                    if (url.searchParams.get('format') !== 'csv')
                        return send(res, 200, p);
                    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="payments-${p.since.slice(0, 10)}-to-${new Date(new Date(p.until).getTime() - 1).toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' });
                    return res.end(admin.paymentsCsv(p));
                }
                if (method === 'GET' && path === '/api/admin/flags')
                    return send(res, 200, await admin.flags(url.searchParams.get('state') ?? 'open'));
                const flag = /^\/api\/admin\/flags\/([\w-]{8,64})\/resolve$/.exec(path);
                if (flag && method === 'POST') {
                    const b = await json(req);
                    return await admin.resolveFlag(by, flag[1], b['note']) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'not-found' });
                }
                if (method === 'GET' && path === '/api/admin/referrals')
                    return send(res, 200, await admin.referrals());
                return send(res, 404, { error: 'not-found' });
            }
            // ---- Local development and tests only ----
            if (config.devFakes && outbox) {
                if (method === 'GET' && path === '/api/dev/outbox')
                    return send(res, 200, outbox.sent.slice(-20));
                // A pretend Payment Link checkout for the signed-in account, delivered as Stripe would.
                if (method === 'POST' && path === '/api/dev/checkout') {
                    const id = signedIn(), b = await json(req);
                    const pack = config.packs.find(p => p.id === b['pack']);
                    if (!pack)
                        throw new HttpError(400, 'pack');
                    const n = Date.now(), amount = Number(b['amountPence'] ?? Math.round(Number(pack.price.replace(/[^\d.]/g, '')) * 100));
                    await service.handleStripeEvent({ id: `evt_dev_${n}`, type: 'checkout.session.completed', data: { object: {
                                id: `cs_dev_${n}`, payment_status: amount > 0 ? 'paid' : 'no_payment_required', client_reference_id: id, payment_link: pack.id,
                                amount_total: amount, currency: 'gbp', payment_intent: amount > 0 ? `pi_dev_${n}` : null, customer_details: { email: null }
                            } } });
                    return send(res, 200, { ok: true });
                }
                if (method === 'POST' && path === '/api/dev/signin') {
                    const b = await json(req);
                    const a = await service.signIn('email', { sub: String(b['email']), email: String(b['email']), emailVerified: true }, str(b['ref'], 20) ?? undefined);
                    setSession(res, a.id);
                    return send(res, 200, { ok: true });
                }
            }
            return send(res, 404, { error: 'not-found' });
        }
        catch (e) {
            if (e instanceof HttpError)
                return send(res, e.status, { error: e.code });
            console.error(`${method} ${path}:`, e instanceof Error ? e.message : e);
            return send(res, 500, { error: 'server' });
        }
    };
}
