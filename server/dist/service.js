import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
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
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** A sign-in code lasts this long; this many wrong guesses end it. */
const CODE_MINUTES = 15, CODE_ATTEMPTS = 5;
/** A drive that fails to load within this long of starting gives its session back; at most this many a day. */
const REFUND_WINDOW_MS = 15 * 60_000, REFUNDS_PER_DAY = 3;
export class Service {
    config;
    store;
    mail;
    ids;
    stripe;
    constructor(config, store, mail, ids, stripe) {
        this.config = config;
        this.store = store;
        this.mail = mail;
        this.ids = ids;
        this.stripe = stripe;
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
            admin: !!a.email && this.config.adminEmails.includes(a.email)
        };
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
        const drive = await this.store.createDrive({ accountId, kind: kind.slice(0, 40), scenario, mode, paidFrom: 'sessions', startedAt: new Date(), status: 'started' });
        const take = (pot) => this.store.appendLedger({ product: 'simulator', accountId, type: 'consumed', sessionsDelta: -1, ...(pot ? { pot } : {}), amountPence: 0, currency: 'gbp', actor: 'customer',
            reason: `${kind}: ${scenario}`, idempotencyKey: `drive:${drive.id}` }, { requireBalance: true });
        let paidFrom = null;
        if (await take(mode) === 'ok')
            paidFrom = mode;
        else if (await take(undefined) === 'ok')
            paidFrom = 'sessions';
        if (!paidFrom) {
            await this.store.updateDrive(drive.id, { status: 'failed' });
            return { ok: false, reason: 'no-sessions' };
        }
        await this.store.updateDrive(drive.id, { paidFrom });
        return { ok: true, drive: { ...drive, paidFrom }, balance: (await this.store.findAccount({ id: accountId })).balance };
    }
    /** The app reports how the drive went; one that failed to load gives its session back. */
    async driveStatus(accountId, driveId, status) {
        const d = await this.store.getDrive(driveId);
        if (!d || d.accountId !== accountId)
            return false;
        if (status === 'failed' && d.status === 'started' && !d.refunded && Date.now() - d.startedAt.getTime() <= REFUND_WINDOW_MS) {
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
    async packForLink(linkId) {
        if (!linkId || !this.stripe)
            return null;
        const link = await this.stripe.paymentLink(linkId);
        if (!link)
            return null;
        const known = this.config.packs.find(p => p.links[this.config.stripeMode] === link.url);
        if (known)
            return known;
        // Not listed: its metadata `sessions` (general sessions only; never a Starter Pass).
        const fromMeta = Number(link.metadata['sessions']);
        return Number.isInteger(fromMeta) && fromMeta > 0 && fromMeta <= 100 ? { id: `link-${linkId}`, label: 'Sessions', price: '', sessions: fromMeta, links: { test: '', live: '' } } : null;
    }
    async stripeWebhook(raw, signature) {
        let event;
        // (Logged without anything secret: whether deliveries arrive, and whether they are signed with this endpoint's secret.)
        try {
            event = this.stripe.constructEvent(raw, signature);
        }
        catch {
            console.log(`Stripe webhook refused: the signature does not match STRIPE_WEBHOOK_SECRET (${raw.length} bytes)`);
            return 'bad-signature';
        }
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
                if (!full) {
                    await this.store.flag('partial-refund', { event: event.id, account: purchase.accountId, paymentIntent: pi, amountRefunded: o['amount_refunded'] });
                    return;
                }
                const charge = String(o['id']);
                // General sessions come back even if spent (the balance can go below zero: drives stop until topped up).
                await this.store.appendLedger({ product: 'simulator', accountId: purchase.accountId, type: 'refund', sessionsDelta: -purchase.sessionsDelta,
                    amountPence: -Number(o['amount_refunded'] ?? purchase.amountPence), currency: String(o['currency'] ?? 'gbp'), actor: 'stripe',
                    stripe: { event: event.id, paymentIntent: pi, charge }, reason: 'Payment refunded', idempotencyKey: `refund:${charge}` });
                // Starter allowances: each unused one is taken back; one already used stays used (flagged for a person).
                for (const grant of entries.filter(e => e.type === 'allowance' && e.sessionsDelta > 0)) {
                    const r = await this.store.appendLedger({ product: 'simulator', accountId: purchase.accountId, type: 'refund', sessionsDelta: -grant.sessionsDelta, pot: grant.pot,
                        amountPence: 0, currency: String(o['currency'] ?? 'gbp'), actor: 'stripe', stripe: { event: event.id, paymentIntent: pi, charge },
                        reason: 'Payment refunded', idempotencyKey: `refund:${charge}:${grant.pot}` }, { requireBalance: true });
                    if (r === 'insufficient')
                        await this.store.flag('refund-after-use', { account: purchase.accountId, paymentIntent: pi, pot: grant.pot });
                }
                // A referral reward that this payment earned stays, for a person to decide (the referrer did nothing wrong).
                const a = await this.store.findAccount({ id: purchase.accountId });
                if (a?.referredBy)
                    await this.store.flag('refund-after-referral-reward', { account: a.id, referrer: a.referredBy, paymentIntent: pi });
                return;
            }
            case 'charge.dispute.created':
                await this.store.flag('dispute', { event: event.id, charge: o['charge'], amount: o['amount'], reason: o['reason'] });
                return;
        }
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
        const pack = await this.packForLink(linkId);
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
