import { readFileSync } from 'node:fs';
export function loadConfig(env = process.env) {
    const devFakes = env['DP_DEV_FAKES'] === '1';
    if (devFakes && env['NODE_ENV'] === 'production')
        throw new Error('DP_DEV_FAKES cannot be used with NODE_ENV=production');
    const need = (name) => {
        const v = env[name];
        if (!v && !devFakes)
            throw new Error(`Missing ${name}`);
        return v || null;
    };
    const stripeSecretKey = need('STRIPE_SECRET_KEY');
    const sessionSecret = env['SESSION_SECRET'] ?? (devFakes ? 'dev-only-secret-dev-only-secret-dev-only' : '');
    if (sessionSecret.length < 32)
        throw new Error('SESSION_SECRET must be at least 32 characters');
    const packsFile = env['PACKS_FILE'] ?? new URL('../packs.json', import.meta.url).pathname;
    const premiumOn = env['PRACTICAL_PREMIUM'] === '1';
    // Practical Premium against the live Practical: every credential set (kept in the Hostless app's settings, never in
    // code). Outside local fakes only on staging: production is refused here until a reviewed change allows it, after
    // the owner's approval (Release 2 waits on Release 1).
    // (PRACTICAL_NOTICE_SECRET is optional: change notices are left out for now, the owner's decision; unset, they are refused.)
    const liveNeeds = ['PRACTICAL_API_BASE', 'PRACTICAL_CLIENT_ID', 'PRACTICAL_PREMIUM_TOKEN'];
    const liveMissing = liveNeeds.filter(k => !env[k]);
    const live = premiumOn && liveMissing.length < liveNeeds.length;
    if (premiumOn && !devFakes) {
        if (!/^https:\/\/staging\.drivingpractice\.live\/?$/.test(env['APP_BASE_URL'] ?? ''))
            throw new Error('PRACTICAL_PREMIUM is allowed on staging only until Release 2 is approved');
        if (liveMissing.length)
            throw new Error(`PRACTICAL_PREMIUM on staging needs ${liveMissing.join(', ')}`);
    }
    if (live && liveMissing.length)
        throw new Error(`PRACTICAL_PREMIUM with the live Practical needs ${liveMissing.join(', ')}`);
    return {
        port: Number(env['PORT'] ?? 8787),
        appBaseUrl: (env['APP_BASE_URL'] ?? 'http://localhost:4173').replace(/\/$/, ''),
        sessionSecret,
        mongoUri: need('MONGODB_URI'),
        stripeSecretKey,
        stripeWebhookSecret: need('STRIPE_WEBHOOK_SECRET'),
        stripeMode: stripeSecretKey?.includes('_live_') ? 'live' : 'test',
        resendApiKey: need('RESEND_API_KEY'),
        emailFrom: env['EMAIL_FROM'] ?? 'Driving Practice <support@drivingpractice.live>',
        emailReplyTo: env['EMAIL_REPLY_TO'] ?? 'support.drivingpractice@gmail.com',
        googleClientId: env['GOOGLE_CLIENT_ID'] || null,
        appleServicesId: env['APPLE_SERVICES_ID'] || null,
        supportInbox: env['SUPPORT_INBOX'] ?? env['EMAIL_REPLY_TO'] ?? 'support.drivingpractice@gmail.com',
        supportPushUrl: env['SUPPORT_PUSH_URL'] || null,
        supportReminderMinutes: Math.max(5, Number(env['SUPPORT_REMINDER_MINUTES'] ?? 30) || 30),
        signInFirst: env['SIGN_IN_FIRST'] ? env['SIGN_IN_FIRST'] === '1' : /^https:\/\/staging\.drivingpractice\.live\/?$/.test(env['APP_BASE_URL'] ?? ''),
        adminEmails: (env['ADMIN_EMAILS'] ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
        // (Local fakes: each pack gets a placeholder link so a pretend checkout can name it.)
        packs: JSON.parse(readFileSync(packsFile, 'utf8')).packs
            .map(p => devFakes && !p.links.test ? { ...p, links: { ...p.links, test: `https://buy.stripe.com/test_dev_${p.id}` } } : p),
        devFakes,
        practicalPremium: premiumOn ? { premiumFirst: (env['PRACTICAL_PREMIUM_FIRST'] ?? '').split(',').map(s => s.trim()).filter(Boolean),
            generalAvailability: env['PRACTICAL_CHALLENGES_GA'] === '1', noticeSecret: env['PRACTICAL_NOTICE_SECRET'] || null,
            live: live ? { base: env['PRACTICAL_API_BASE'], clientId: env['PRACTICAL_CLIENT_ID'], premiumToken: env['PRACTICAL_PREMIUM_TOKEN'],
                demandToken: env['PRACTICAL_DEMAND_TOKEN'] || null } : null } : null
    };
}
