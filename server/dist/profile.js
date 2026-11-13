/**
 * A learner's profile, from their own finished drives: how many of each kind, the last few with how they went, their
 * best mock test, the areas that cost them most, and how their mock tests have gone over time.
 */
/** What a drive's result may hold (anything else, or too much, is dropped: it comes from the browser). */
export function cleanResult(raw) {
    if (!raw || typeof raw !== 'object')
        return undefined;
    const r = raw;
    const n = (v, max = 999) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(max, Math.round(v)) : undefined;
    const text = (v, max = 80) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
    const out = {};
    const seconds = n(r['seconds'], 6 * 3600);
    if (seconds !== undefined)
        out.seconds = seconds;
    const t = r['test'];
    if (t && typeof t === 'object') {
        out.test = { passed: t['passed'] === true, driving: n(t['driving'], 99) ?? 0, serious: n(t['serious'], 99) ?? 0, dangerous: n(t['dangerous'], 99) ?? 0, finished: t['finished'] !== false };
    }
    const l = r['lesson'];
    if (l && typeof l === 'object') {
        const title = text(l['title']);
        if (title)
            out.lesson = { title, good: n(l['good'], 99) ?? 0, improve: n(l['improve'], 99) ?? 0 };
    }
    if (Array.isArray(r['areas'])) {
        out.areas = r['areas'].slice(0, 30).flatMap(a => {
            const x = a, label = text(x?.['label'], 60);
            return label ? [{ label, driving: n(x['driving'], 99) ?? 0, serious: n(x['serious'], 99) ?? 0, dangerous: n(x['dangerous'], 99) ?? 0 }] : [];
        });
    }
    return Object.keys(out).length ? out : undefined;
}
/** The profile from an account's drives (newest first, as the store lists them). */
export function profileOf(drives) {
    const done = drives.filter(d => (d.status === 'completed' || d.status === 'ended') && d.endedAt)
        .sort((a, b) => b.endedAt.getTime() - a.endedAt.getTime());
    const completed = done.filter(d => d.status === 'completed');
    const totals = { lesson: 0, test: 0, free: 0, minutes: 0 };
    for (const d of completed)
        totals[d.mode]++;
    for (const d of done)
        totals.minutes += (d.result?.seconds ?? 0) / 60;
    totals.minutes = Math.round(totals.minutes);
    const recent = done.slice(0, 10).map(d => ({ scenario: d.scenario, mode: d.mode, at: d.endedAt.toISOString(), outcome: d.outcome ?? d.status,
        ...(d.result?.test ? { test: d.result.test } : {}), ...(d.result?.lesson ? { lesson: d.result.lesson } : {}) }));
    // Mock tests driven to the examiner's end.
    const tests = done.filter(d => d.result?.test?.finished);
    let best = null;
    if (tests.length) {
        const score = (d) => { const t = d.result.test; return (t.passed ? 0 : 1000) + t.dangerous * 100 + t.serious * 10 + t.driving; };
        const top = [...tests].sort((a, b) => score(a) - score(b))[0];
        best = { tests: tests.length, passes: tests.filter(d => d.result.test.passed).length,
            fewestFaults: top.result.test.driving, bestAt: top.endedAt.toISOString(), scenario: top.scenario };
    }
    // Weak areas: what the last ten tests marked most (serious and dangerous count for more).
    const areas = new Map();
    for (const d of done.filter(d => d.result?.areas?.length).slice(0, 10))
        for (const a of d.result.areas) {
            const r = areas.get(a.label) ?? { label: a.label, times: 0, serious: 0, dangerous: 0 };
            r.times += a.driving + a.serious + a.dangerous;
            r.serious += a.serious;
            r.dangerous += a.dangerous;
            areas.set(a.label, r);
        }
    const weight = (r) => r.times + r.serious * 2 + r.dangerous * 4;
    const weak = [...areas.values()].filter(r => r.times > 0).sort((a, b) => weight(b) - weight(a)).slice(0, 5);
    const progress = tests.slice(0, 10).reverse().map(d => ({ at: d.endedAt.toISOString(), driving: d.result.test.driving,
        serious: d.result.test.serious, dangerous: d.result.test.dangerous, passed: d.result.test.passed }));
    return { totals, recent, best, weak, progress };
}
