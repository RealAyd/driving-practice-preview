import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Support } from './support.js';
/** What a drive is, from its scenario id (the browser's own description of it is not trusted). */
export function modeOf(scenario) {
    return scenario.endsWith('-mock-test') ? 'test' : scenario.endsWith('-lesson') ? 'lesson' : 'free';
}
const SCENARIO = /^[a-z0-9][a-z0-9-]{0,79}$/;
const POTS = ['lesson', 'test', 'free'];
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const sameHash = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** Referral codes: no 0/O or 1/I/L, so they can be read out. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const referralCode = () => Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
export const normaliseEmail = (email) => email.trim().toLowerCase();
/** One person behind several aliases: Gmail ignores dots and anything after +; other providers commonly ignore +. */
export function emailKey(email) {
    const [local = '', domain = ''] = normaliseEmail(email).split('@');
    const base = local.split('+')[0];
    const gmail = domain === 'gmail.com' || domain === 'googlemail.com';
    return `${gmail ? base.replace(/\./g, '') : base}@${gmail ? 'gmail.com' : domain}`;
}
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Whether a verified email is one of ADMIN_EMAILS, by alias (a Gmail address with dots or a +tag still counts). */
export const isAdminEmail = (config, email) => !!email && config.adminEmails.some(a => emailKey(a) === emailKey(email));
/** A sign-in code lasts this long; this many wrong guesses end it. */
const CODE_MINUTES = 15, CODE_ATTEMPTS = 5;
/** Partial refunds below this, in all on one payment, leave the sessions as they are without review (£5). */
const SMALL_PARTIAL_REFUND_PENCE = 500;
/** A drive that fails to load within this long of starting gives its session back; at most this many a day. */
const REFUND_WINDOW_MS = 15 * 60_000, REFUNDS_PER_DAY = 3;
/** New free tries from one address in a day (a device's try is in its cookie; this stops clearing it for more). Many
 * phones share one address (mobile networks, a school or office Wi-Fi), so it is well above one household's. */
export const TRIALS_PER_IP_PER_DAY = 30;
/** A lesson id as the app names them; at most this many kept. */
const LESSON_ID = /^[a-z0-9-]{1,40}$/, MAX_LESSONS = 100;
export class Service {
    config;
    store;
    mail;
    ids;
    stripe;
    /** Support requests (tickets, the response timer, the notification outbox). */
    support;
    constructor(config, store, mail, ids, stripe, pusher = null) {
        this.config = config;
        this.store = store;
        this.mail = mail;
        this.ids = ids;
        this.stripe = stripe;
        this.support = new Support(config, store, mail, pusher);
    }
    // ---- Accounts and referrals ----
    /**
     * Signs in with a verified identity, creating the account the first time. A new account that arrived through a
     * referral link gets its free drive (once per person, by email alias).
     */
    async signIn(provider, id, ref) {
        const email = id.email && id.emailVerified ? normaliseEmail(id.email) : null;
        const bySub = provider === 'google' ? await this.store.findAccount({ googleSub: id.sub }) : provider === 'apple' ? await this.store.findAccount({ appleSub: id.sub }) : null;
        if (bySub)
            return bySub;
        const byEmail = email ? await this.store.findAccount({ email }) : null;
        if (byEmail) {
            // The same person with another way in: linked by the verified email.
            if (provider === 'google')
                await this.store.updateAccount(byEmail.id, { googleSub: id.sub });
            if (provider === 'apple')
                await this.store.updateAccount(byEmail.id, { appleSub: id.sub });
            return (await this.store.findAccount({ id: byEmail.id }));
        }
        if (!email && provider !== 'apple')
            throw new Error('A verified email is needed');
        const key = email ? emailKey(email) : null;
        // Someone who had an account under another alias does not count as new for the free drive.
        const known = key ? await this.store.findAccount({ emailKey: key }) : null;
        let created = null;
        for (let tries = 0; !created && tries < 5; tries++) {
            created = await this.store.createAccount({ email, emailKey: key, referralCode: referralCode(),
                ...(provider === 'google' ? { googleSub: id.sub } : provider === 'apple' ? { appleSub: id.sub } : {}) });
            // (A clash is the email, signed up a moment ago by another request, or a referral code: look again.)
            if (!created && email) {
                const again = await this.store.findAccount({ email });
                if (again)
                    return again;
            }
        }
        if (!created)
            throw new Error('Could not create the account');
        if (ref)
            await this.applyReferral(created, ref.trim().toUpperCase(), !!known);
        return (await this.store.findAccount({ id: created.id }));
    }
    async applyReferral(account, code, knownPerson) {
        const referrer = await this.store.findAccount({ referralCode: code });
        if (!referrer || referrer.id === account.id)
            return;
        if (knownPerson || (referrer.emailKey && referrer.emailKey === account.emailKey)) {
            await this.store.flag('referral-refused', { account: account.id, referrer: referrer.id, why: knownPerson ? 'already had an account (email alias)' : 'own link' });
            return;
        }
        await this.store.updateAccount(account.id, { referredBy: referrer.id });
        await this.store.appendLedger({ product: 'simulator', accountId: account.id, type: 'referral_free_drive', sessionsDelta: 1, amountPence: 0, currency: 'gbp',
            actor: 'system', reason: `Free drive: invited by ${referrer.referralCode}`, idempotencyKey: `referral-free:${account.id}` });
        // Many sign-ups on one code in a day are for a person to look at (not refused).
        if (!await this.store.rateHit(`referrals:${referrer.id}`, 24 * 3600_000, 10))
            await this.store.flag('referral-volume', { referrer: referrer.id, code });
    }
    async me(accountId) {
        const a = await this.store.findAccount({ id: accountId });
        if (!a)
            return null;
        const ledger = await this.store.ledger({ accountId });
        return {
            // (The id goes on the Payment Link as client_reference_id, so the webhook knows whose payment it is.)
            id: a.id, email: a.email, balance: a.balance, allowances: Object.fromEntries(POTS.map(p => [p, a.allowances?.[p] ?? 0])), starterBought: !!a.starterBought, referralCode: a.referralCode,
            invited: await this.store.countReferred(a.id), rewarded: ledger.filter(e => e.type === 'referral_bonus').length,
            history: ledger.slice(-20).reverse().map(e => ({ type: e.type, sessions: e.sessionsDelta, amountPence: e.amountPence, reason: e.reason, at: e.createdAt.toISOString() })),
            admin: isAdminEmail(this.config, a.email),
            lessonsDone: a.lessonsDone ?? []
        };
    }
    /** Adds lessons finished (on any device) to the account's; returns them all. */
    async saveProgress(accountId, lessons) {
        const a = await this.store.findAccount({ id: accountId });
        if (!a)
            return [];
        const all = [...new Set([...(a.lessonsDone ?? []), ...lessons.filter(l => LESSON_ID.test(l))])].slice(0, MAX_LESSONS);
        if (all.length !== (a.lessonsDone ?? []).length)
            await this.store.updateAccount(accountId, { lessonsDone: all });
        return all;
    }
    // ---- Email sign-in: a 6-digit code (typed into the app) and a link (opens in the browser) ----
    async requestEmailCode(rawEmail, ip, ref) {
        const email = normaliseEmail(rawEmail);
        if (!EMAIL.test(email) || email.length > 254)
            return 'invalid';
        if (!await this.store.rateHit(`email:${email}`, 3600_000, 5) || !await this.store.rateHit(`ip:${ip}`, 3600_000, 30))
            return 'slow-down';
        const code = String(randomInt(1_000_000)).padStart(6, '0'), token = randomBytes(32).toString('base64url');
        await this.store.saveLoginCode({ email, tokenHash: sha256(token), codeHash: sha256(`${email}:${code}`), expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000), attempts: 0, ...(ref ? { ref } : {}) });
        const link = `${this.config.appBaseUrl}/api/auth/email/verify?token=${token}`;
        await this.mail.send({ to: email, subject: `Your Driving Practice sign-in code: ${code}`,
            text: `Your sign-in code is ${code}\n\nType it into Driving Practice, or open this link on the same device:\n${link}\n\nIt works once, for ${CODE_MINUTES} minutes. If you did not ask for it, ignore this email.`,
            html: `<p>Your sign-in code is</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>Type it into Driving Practice, or <a href="${link}">sign in with this link</a> on the same device.</p><p style="color:#666">It works once, for ${CODE_MINUTES} minutes. If you did not ask for it, ignore this email.</p>` });
        return 'sent';
    }
    async verifyEmailCode(rawEmail, code) {
        const email = normaliseEmail(rawEmail);
        const c = await this.store.findLoginCode({ email });
        if (!c || c.usedAt || c.expiresAt < new Date() || c.attempts >= CODE_ATTEMPTS)
            return null;
        if (!sameHash(c.codeHash, sha256(`${email}:${code.trim()}`))) {
            await this.store.updateLoginCode(c.id, { attempts: c.attempts + 1 });
            return null;
        }
        await this.store.updateLoginCode(c.id, { usedAt: new Date() });
        return this.signIn('email', { sub: email, email, emailVerified: true }, c.ref);
    }
    async verifyEmailToken(token) {
        const c = await this.store.findLoginCode({ tokenHash: sha256(token) });
        if (!c || c.usedAt || c.expiresAt < new Date())
            return null;
        await this.store.updateLoginCode(c.id, { usedAt: new Date() });
        return this.signIn('email', { sub: c.email, email: c.email, emailVerified: true }, c.ref);
    }
    async signInWith(provider, credential, ref) {
        const id = provider === 'google' ? await this.ids.google(credential) : await this.ids.apple(credential);
        return this.signIn(provider, id, ref);
    }
    // ---- Drives: each one started uses one session ----
    /**
     * A drive of the kind its scenario is: a Starter allowance for that kind is used first, otherwise one general
     * session. Taking it is atomic, so two drives started at once cannot both use the last one.
     */
    async startDrive(accountId, kind, scenario) {
        if (!SCENARIO.test(scenario))
            return { ok: false, reason: 'no-sessions' };
        const mode = modeOf(scenario);
        // The admins (ADMIN_EMAILS) drive without using sessions: recorded as a drive, nothing taken.
        const account = await this.store.findAccount({ id: accountId });
        if (account && isAdminEmail(this.config, account.email)) {
            const drive = await this.store.createDrive({ accountId, kind: kind.slice(0, 40), scenario, mode, paidFrom: 'admin', startedAt: new Date(), status: 'started' });
            return { ok: true, drive, balance: account.balance };
        }
        const drive = await this.store.createDrive({ accountId, kind: kind.slice(0, 40), scenario, mode, paidFrom: 'sessions', startedAt: new Date(), status: 'started' });
        const take = (pot) => this.store.appendLedger({ product: 'simulator', accountId, type: 'consumed', sessionsDelta: -1, ...(pot ? { pot } : {}), amountPence: 0, currency: 'gbp', actor: 'customer',
            reason: `${kind}: ${scenario}`, idempotencyKey: `drive:${drive.id}` }, { requireBalance: true });
        let paidFrom = null;
        if (await take(mode) === 'ok')
            paidFrom = mode;
        else if (await take(undefined) === 'ok')
            paidFrom = 'sessions';
        if (!paidFrom) {
            await this.store.updateDrive(drive.id, { status: 'unpaid' });
            return { ok: false, reason: 'no-sessions' };
        }
        await this.store.updateDrive(drive.id, { paidFrom });
        return { ok: true, drive: { ...drive, paidFrom }, balance: (await this.store.findAccount({ id: accountId })).balance };
    }
    // ---- The free try (no sign-up): one lesson, one mock test and one free drive per device ----
    /** What is left of a device's free try (all of it before the first drive). */
    async trialLeft(trialId) {
        const t = trialId ? await this.store.getTrial(trialId) : null;
        return t ? { ...t.remaining } : { lesson: 1, test: 1, free: 1 };
    }
    /**
     * A drive on the device's free try: the try is made on the first drive (rate-limited by address), then each kind
     * can be used once. Returns the try's id (for the device's cookie) with the outcome.
     */
    async startTrialDrive(trialId, ip, kind, scenario) {
        if (!SCENARIO.test(scenario))
            return { trialId, start: { ok: false, reason: 'trial-used' } };
        let trial = trialId ? await this.store.getTrial(trialId) : null;
        if (!trial) {
            if (!await this.store.rateHit(`trial-ip:${ip}`, 24 * 3600_000, TRIALS_PER_IP_PER_DAY))
                return { trialId: null, start: { ok: false, reason: 'slow-down' } };
            trial = await this.store.createTrial();
        }
        const mode = modeOf(scenario);
        if (!await this.store.moveTrial(trial.id, mode, -1))
            return { trialId: trial.id, start: { ok: false, reason: 'trial-used' } };
        const drive = await this.store.createDrive({ accountId: `trial:${trial.id}`, kind: kind.slice(0, 40), scenario, mode, paidFrom: 'trial', startedAt: new Date(), status: 'started' });
        return { trialId: trial.id, start: { ok: true, drive, balance: 0 } };
    }
    /** The app reports how the drive went; one that failed to load gives its session back. */
    async driveStatus(accountId, driveId, status) {
        const d = await this.store.getDrive(driveId);
        if (!d || d.accountId !== accountId || d.status === 'unpaid')
            return false;
        if (status === 'failed' && d.status === 'started' && d.paidFrom !== 'admin' && !d.refunded && Date.now() - d.startedAt.getTime() <= REFUND_WINDOW_MS) {
            // A free try's drive goes back to the try (once).
            if (d.paidFrom === 'trial') {
                await this.store.updateDrive(driveId, { status, refunded: true });
                await this.store.moveTrial(accountId.slice(6), d.mode, 1);
                return true;
            }
            const today = await this.store.countDrives({ accountId, since: new Date(Date.now() - 24 * 3600_000), refunded: true });
            if (today >= REFUNDS_PER_DAY) {
                await this.store.flag('drive-refunds', { account: accountId, drive: driveId });
                await this.store.updateDrive(driveId, { status });
                return true;
            }
            const r = await this.store.appendLedger({ product: 'simulator', accountId, type: 'drive_refund', sessionsDelta: 1, ...(d.paidFrom !== 'sessions' ? { pot: d.paidFrom } : {}),
                amountPence: 0, currency: 'gbp', actor: 'system', reason: 'The drive did not load', idempotencyKey: `drive-refund:${driveId}` });
            await this.store.updateDrive(driveId, { status, refunded: r === 'ok' || r === 'duplicate' });
            return true;
        }
        if (d.status !== 'completed')
            await this.store.updateDrive(driveId, { status });
        return true;
    }
    // ---- Payments (Stripe Payment Links) ----
    /** The packs on sale in this mode, as the app shows them. */
    packs() {
        return this.config.packs.map(p => ({ id: p.id, label: p.label, price: p.price, description: p.description ?? '', sessions: p.sessions, allowances: p.allowances ?? {},
            starter: !!p.starter, onSale: !!p.links[this.config.stripeMode] }));
    }
    /**
     * The address to pay for a pack: its Payment Link with this account as the client reference (the webhook credits
     * that account). The Starter Pass is not offered to an account that has it.
     */
    async checkoutUrl(accountId, packId) {
        const pack = this.config.packs.find(p => p.id === packId);
        if (!pack)
            return { error: 'unknown-pack' };
        const link = pack.links[this.config.stripeMode];
        if (!link)
            return { error: 'not-on-sale' };
        const a = await this.store.findAccount({ id: accountId });
        if (!a)
            return { error: 'unknown-pack' };
        if (pack.starter && a.starterBought)
            return { error: 'starter-bought' };
        const url = new URL(link);
        url.searchParams.set('client_reference_id', a.id);
        if (a.email)
            url.searchParams.set('prefilled_email', a.email);
        return { url: url.toString() };
    }
    /** The pack a paid Payment Link sells: the link is looked up with Stripe and matched to the server's own packs. */
    async packForLink(linkId, amountPence) {
        if (!linkId || !this.stripe)
            return null;
        let link;
        try {
            link = await this.stripe.paymentLink(linkId);
        }
        catch (e) {
            // Stripe could not be asked (most often: the key cannot read Payment Links). Said in the log; the pack is then
            // the one whose price is exactly what was paid (a discounted payment cannot be told apart: flagged instead).
            console.error(`Stripe Payment Link lookup failed (${linkId}): ${e instanceof Error ? e.message.slice(0, 200) : 'error'}. Check the key can read Payment Links.`);
            const byPrice = this.config.packs.filter(p => Math.round(Number(p.price.replace(/[^\d.]/g, '')) * 100) === amountPence);
            return byPrice.length === 1 ? byPrice[0] : null;
        }
        if (!link)
            return null;
        const known = this.config.packs.find(p => p.links[this.config.stripeMode] === link.url);
        if (known)
            return known;
        // Not listed: its metadata `sessions` (general sessions only; never a Starter Pass).
        const fromMeta = Number(link.metadata['sessions']);
        return Number.isInteger(fromMeta) && fromMeta > 0 && fromMeta <= 100 ? { id: `link-${linkId}`, label: 'Sessions', price: '', sessions: fromMeta, links: { test: '', live: '' } } : null;
    }
    /** Since this server started: webhook deliveries accepted and refused (for the admin hub). */
    webhookStats = { received: 0, lastReceivedAt: null, refused: 0, lastRefusedAt: null };
    async stripeWebhook(raw, signature) {
        let event;
        // (Logged without anything secret: whether deliveries arrive, and whether they are signed with this endpoint's secret.)
        try {
            event = this.stripe.constructEvent(raw, signature);
        }
        catch {
            this.webhookStats.refused++;
            this.webhookStats.lastRefusedAt = new Date();
            console.log(`Stripe webhook refused: the signature does not match STRIPE_WEBHOOK_SECRET (${raw.length} bytes)`);
            return 'bad-signature';
        }
        this.webhookStats.received++;
        this.webhookStats.lastReceivedAt = new Date();
        console.log(`Stripe webhook: ${event.type} ${event.id}`);
        await this.handleStripeEvent(event);
        return 'ok';
    }
    async handleStripeEvent(event) {
        const o = event.data.object;
        switch (event.type) {
            case 'checkout.session.completed':
            case 'checkout.session.async_payment_succeeded': {
                // Paid, or nothing to pay (a 100% promotion code); card payments arrive as 'paid' here. Others wait for
                // async_payment_succeeded.
                const status = o['payment_status'];
                if (status !== 'paid' && status !== 'no_payment_required')
                    return;
                await this.credit(event, o);
                return;
            }
            case 'charge.refunded': {
                const pi = typeof o['payment_intent'] === 'string' ? o['payment_intent'] : null;
                const entries = pi ? await this.store.ledger({ paymentIntent: pi }) : [];
                const purchase = entries.find(e => e.type === 'purchase');
                if (!purchase) {
                    await this.store.flag('refund-unmatched', { event: event.id, paymentIntent: pi });
                    return;
                }
                // A second Starter Pass refunded by this service: nothing was granted, so only the money is recorded.
                if (entries.some(e => e.type === 'starter_duplicate')) {
                    await this.store.appendLedger({ product: 'simulator', accountId: purchase.accountId, type: 'refund', sessionsDelta: 0, amountPence: -Number(o['amount_refunded'] ?? 0),
                        currency: String(o['currency'] ?? 'gbp'), actor: 'stripe', stripe: { event: event.id, paymentIntent: pi, charge: String(o['id']) },
                        reason: 'Second Starter Pass refunded', idempotencyKey: `refund:${String(o['id'])}` });
                    return;
                }
                const full = o['refunded'] === true || o['amount_refunded'] === o['amount'];
                const charge = String(o['id']), currency = String(o['currency'] ?? 'gbp');
                // Stripe gives the total refunded so far on this payment: the money already recorded for it is taken off.
                const refundedTotal = Number(o['amount_refunded'] ?? (full ? purchase.amountPence : 0));
                const recorded = -entries.filter(e => e.type === 'refund' && e.stripe?.charge === charge).reduce((n, e) => n + e.amountPence, 0);
                if (!full) {
                    // A partial refund (a goodwill gesture, a promotion code that was missed): the money is recorded and the
                    // sessions stay. Under £5 in all on this payment that is all; from £5 a person decides about the sessions.
                    if (refundedTotal <= recorded)
                        return;
                    const small = refundedTotal < SMALL_PARTIAL_REFUND_PENCE;
                    await this.store.appendLedger({ product: 'simulator', accountId: purchase.accountId, type: 'refund', sessionsDelta: 0, amountPence: -(refundedTotal - recorded), currency,
                        actor: 'stripe', stripe: { event: event.id, paymentIntent: pi, charge }, reason: small ? 'Partial refund (sessions kept)' : 'Partial refund (sessions under review)',
                        idempotencyKey: `refund:${charge}:${refundedTotal}` });
                    if (!small)
                        await this.store.flag('partial-refund', { event: event.id, account: purchase.accountId, paymentIntent: pi, amountRefunded: refundedTotal });
                    return;
                }
                // General sessions come back even if spent (the balance can go below zero: drives stop until topped up).
                await this.store.appendLedger({ product: 'simulator', accountId: purchase.accountId, type: 'refund', sessionsDelta: -purchase.sessionsDelta,
                    amountPence: -Math.max(0, refundedTotal - recorded), currency, actor: 'stripe',
                    stripe: { event: event.id, paymentIntent: pi, charge }, reason: 'Payment refunded', idempotencyKey: `refund:${charge}` });
                // Starter allowances: each unused one is taken back; one already used stays used (flagged for a person).
                for (const grant of entries.filter(e => e.type === 'allowance' && e.sessionsDelta > 0)) {
                    const r = await this.store.appendLedger({ product: 'simulator', accountId: purchase.accountId, type: 'refund', sessionsDelta: -grant.sessionsDelta, pot: grant.pot,
                        amountPence: 0, currency: String(o['currency'] ?? 'gbp'), actor: 'stripe', stripe: { event: event.id, paymentIntent: pi, charge },
                        reason: 'Payment refunded', idempotencyKey: `refund:${charge}:${grant.pot}` }, { requireBalance: true });
                    if (r === 'insufficient')
                        await this.store.flag('refund-after-use', { account: purchase.accountId, paymentIntent: pi, pot: grant.pot });
                }
                // A referral reward that this payment earned stays with the referrer (they did nothing wrong).
                return;
            }
            case 'charge.dispute.created':
                await this.store.flag('dispute', { event: event.id, charge: o['charge'], amount: o['amount'], reason: o['reason'] });
                return;
        }
    }
    /**
     * Back from paying: Stripe is asked for this account's completed checkouts of the last two days, and any the
     * webhook has not credited yet are credited now (the same steps, keyed on the checkout, so nothing is ever credited
     * twice whichever comes first). Crediting then does not depend on the webhook arriving.
     */
    async reconcile(accountId) {
        const a = await this.store.findAccount({ id: accountId });
        if (!a)
            return { error: 'not-found' };
        if (!this.stripe)
            return { error: 'unavailable' };
        if (!await this.store.rateHit(`reconcile:${accountId}`, 600_000, 30))
            return { error: 'slow-down' };
        let sessions;
        try {
            sessions = await this.stripe.recentCheckouts(new Date(Date.now() - 48 * 3600_000));
        }
        catch (e) {
            console.error(`Stripe checkout lookup failed: ${e instanceof Error ? e.message.slice(0, 200) : 'error'}. Check the key can read Checkout Sessions.`);
            return { error: 'unavailable' };
        }
        const credited = new Set((await this.store.ledger({ accountId })).map(e => e.stripe?.checkoutSession).filter(Boolean));
        const email = a.email;
        let n = 0;
        for (const o of sessions) {
            const ref = typeof o['client_reference_id'] === 'string' ? o['client_reference_id'] : null;
            const payer = o['customer_details']?.email;
            // Its own (by the reference the server put on the link), or paid without one from this account's email.
            const mine = ref ? ref === a.id : !!email && !!payer && normaliseEmail(payer) === email;
            const paid = o['payment_status'] === 'paid' || o['payment_status'] === 'no_payment_required';
            if (!mine || !paid || credited.has(String(o['id'])))
                continue;
            await this.credit({ id: 'reconcile', type: 'checkout.session.completed', data: { object: o } }, o);
            n++;
        }
        if (n)
            console.log(`Stripe reconcile: ${n} checkout(s) credited that the webhook had not delivered`);
        return { credited: n };
    }
    /**
     * A paid checkout: every step is idempotent (keys on the checkout), so a webhook delivered twice, or two deliveries
     * at the same moment, grant once, and a delivery that stopped part-way finishes on the retry.
     */
    async credit(event, o) {
        const sessionId = String(o['id']);
        const ref = typeof o['client_reference_id'] === 'string' ? o['client_reference_id'] : null;
        const details = o['customer_details'];
        const account = (ref ? await this.store.findAccount({ id: ref }) : null)
            ?? (details?.email ? await this.store.findAccount({ email: normaliseEmail(details.email) }) : null);
        const linkId = typeof o['payment_link'] === 'string' ? o['payment_link'] : null;
        const pack = await this.packForLink(linkId, Number(o['amount_total'] ?? 0));
        if (!account || !pack) {
            await this.store.flag(account ? 'payment-unknown-pack' : 'payment-no-account', { event: event.id, checkoutSession: sessionId, paymentLink: linkId, email: details?.email ?? null, ref });
            return;
        }
        const amount = Number(o['amount_total'] ?? 0), currency = String(o['currency'] ?? 'gbp');
        const pi = typeof o['payment_intent'] === 'string' ? o['payment_intent'] : undefined;
        const stripe = { event: event.id, checkoutSession: sessionId, ...(pi ? { paymentIntent: pi } : {}), ...(linkId ? { paymentLink: linkId } : {}) };
        // The payment itself (the money, and any general sessions).
        await this.store.appendLedger({ product: 'simulator', accountId: account.id, type: amount > 0 ? 'purchase' : 'promo', sessionsDelta: pack.sessions, amountPence: amount,
            currency, actor: 'stripe', stripe, reason: pack.label, idempotencyKey: `checkout:${sessionId}` });
        if (pack.starter) {
            const claim = await this.store.claimStarter(account.id, sessionId);
            if (claim === 'lost') {
                await this.duplicateStarter(account.id, sessionId, pi, amount, currency);
                return;
            }
            for (const pot of POTS) {
                const n = pack.allowances?.[pot] ?? 0;
                if (n > 0)
                    await this.store.appendLedger({ product: 'simulator', accountId: account.id, type: 'allowance', sessionsDelta: n, pot, amountPence: 0, currency, actor: 'stripe', stripe,
                        reason: `${pack.label}: ${pot === 'test' ? 'mock test' : pot === 'free' ? 'free drive' : 'lesson'}`, idempotencyKey: `checkout:${sessionId}:${pot}` });
            }
        }
        // A payment with money: the person who invited them gets their free session (once per invited person).
        if (amount > 0) {
            if (!account.firstPaidAt)
                await this.store.updateAccount(account.id, { firstPaidAt: new Date() });
            if (account.referredBy)
                await this.store.appendLedger({ product: 'simulator', accountId: account.referredBy, type: 'referral_bonus', sessionsDelta: 1, amountPence: 0, currency: 'gbp',
                    actor: 'system', reason: 'Free session: someone you invited bought sessions', idempotencyKey: `referral-bonus:${account.id}` });
        }
    }
    /**
     * A second Starter Pass (the Payment Link is public, so it can be paid twice): nothing is granted and the payment
     * is refunded in full straight away. If Stripe refuses the refund it is flagged for a person to refund by hand.
     */
    async duplicateStarter(accountId, sessionId, pi, amount, currency) {
        const first = await this.store.appendLedger({ product: 'simulator', accountId, type: 'starter_duplicate', sessionsDelta: 0, amountPence: 0, currency, actor: 'system',
            ...(pi ? { stripe: { checkoutSession: sessionId, paymentIntent: pi } } : {}),
            reason: amount > 0 ? 'Starter Pass already bought: this payment is refunded' : 'Starter Pass already bought: not granted again', idempotencyKey: `starter-duplicate:${sessionId}` });
        if (first !== 'ok' || amount <= 0 || !pi)
            return;
        const refunded = await this.stripe.refund(pi, 'Starter Pass already bought on this account').catch(() => false);
        if (!refunded)
            await this.store.flag('starter-duplicate-refund-needed', { account: accountId, checkoutSession: sessionId, paymentIntent: pi, amountPence: amount });
    }
}
