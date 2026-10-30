// End-to-end + database-layer tests. Uses a temporary local libSQL file, never hosted Turso.
process.env.NODE_ENV = 'test';
process.env.TURSO_DATABASE_URL = 'file:' + require('node:path').join(require('node:os').tmpdir(), 'sharelab-test-' + Date.now() + '.db');
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.DB_PATH;

const { server, ready, db, seed } = require('./server.js');
const assert = require('node:assert');
const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
let base, passed = 0;
const call = async (tok, path, body) => { const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: body && JSON.stringify(body) }); return { s: r.status, j: await r.json() }; };
const login = async e => (await fetch(base + '/api/login', { method: 'POST', body: JSON.stringify({ email: e, password: 'demo1234' }) }).then(r => r.json())).token;
const ok = (n, c) => { assert.ok(c, 'FAILED: ' + n); passed++; console.log('  ok  ' + n); };

ready.then(() => server.listen(0, async () => {
  base = 'http://localhost:' + server.address().port;
  try {
    // ---- database layer ----
    await db.init();
    await db.init();
    ok('schema init is idempotent', (await db.one('SELECT COUNT(*) v FROM users')).v >= 6);
    const usersBefore = (await db.one('SELECT COUNT(*) v FROM users')).v;
    const skip = await seed(false);
    ok('demo seed does not reset existing data', skip.seeded === false && (await db.one('SELECT COUNT(*) v FROM users')).v === usersBefore);
    try {
      await db.withTransaction(async () => {
        await db.run("INSERT INTO users(id,name,email,role,pw,verified) VALUES('tx-rollback','x','tx-rollback@demo','user','x',1)");
        throw Object.assign(new Error('rollback test'), { code: 400 });
      });
    } catch (e) { if (e.message !== 'rollback test') throw e; }
    ok('write transaction rolls back on failure', !(await db.one("SELECT id FROM users WHERE id='tx-rollback'")));
    await db.withTransaction(async () => {
      await db.run("INSERT INTO users(id,name,email,role,pw,verified) VALUES('tx-commit','x','tx-commit@demo','user','x',1)");
    });
    ok('write transaction commits on success', !!(await db.one("SELECT id FROM users WHERE id='tx-commit'")));
    await db.run("DELETE FROM users WHERE id='tx-commit'");
    const prevEnv = process.env.NODE_ENV, prevUrl = process.env.TURSO_DATABASE_URL, prevTok = process.env.TURSO_AUTH_TOKEN;
    process.env.NODE_ENV = 'production'; process.env.TURSO_DATABASE_URL = 'file:/tmp/sharelab-prod-forbidden.db'; delete process.env.TURSO_AUTH_TOKEN;
    let prodFileBlocked = false; try { db.resolveConfig(); } catch { prodFileBlocked = true; }
    process.env.NODE_ENV = prevEnv; process.env.TURSO_DATABASE_URL = prevUrl; if (prevTok) process.env.TURSO_AUTH_TOKEN = prevTok; else delete process.env.TURSO_AUTH_TOKEN;
    ok('production rejects local file database', prodFileBlocked);
    ok('health check uses database', (await fetch(base + '/healthz').then(r => r.json())).ok === true);

    const [asha, ravi, owner, mgr, admin, owner2] = await Promise.all(['student@demo', 'student2@demo', 'owner@demo', 'manager@demo', 'admin@demo', 'owner2@demo'].map(login));
    ok('wrong password rejected', (await fetch(base + '/api/login', { method: 'POST', body: JSON.stringify({ email: 'student@demo', password: 'x' }) })).status === 401);
    ok('unauthenticated state blocked', (await call('', '/api/state')).s === 401);
    ok('unverified owner cannot list', (await call(owner2, '/api/act', { a: 'newres', n: 'X', c: 'Rooms', l: 'Y', m: 'auto', q: 2, rule: 'z' })).s === 403);
    await db.run("UPDATE res SET o='u6' WHERE id='r1'");
    ok('unverified owner cannot approve', (await call(owner2, '/api/act', { a: 'approve', id: 'B1' })).s === 403);
    await db.run("UPDATE res SET o='u3' WHERE id='r1'");
    ok('admin verifies owner', (await call(admin, '/api/act', { a: 'vown', u: 'u6' })).s === 200);
    ok('verified owner lists resource', (await call(owner2, '/api/act', { a: 'newres', n: 'Laser Cutter', c: 'Makerspace', l: 'B-20', req: ['safety'], m: 'manual', q: 4, rule: 'Eye protection' })).s === 200);
    // lifecycle on r1 (manual approval, needs safety training)
    const slot = { a: 'submit', r: 'r1', day: day(3), s: 10, h: 2, purpose: 'Enclosure prototype' };
    const sub = await call(asha, '/api/act', slot); ok('student request -> pending', sub.j.st === 'pending');
    ok('student cannot approve own request', (await call(asha, '/api/act', { a: 'approve', id: sub.j.id })).s === 403);
    // fairness: Ravi already has 5h of 6h quota -> waitlisted, same slot also conflicts
    const w = await call(ravi, '/api/act', { ...slot, purpose: 'Second request' }); ok('over-quota/conflicting request -> waitlisted', w.j.st === 'waitlisted');
    ok('eligibility enforced (CNC needs credentials)', (await call(asha, '/api/act', { a: 'submit', r: 'r4', day: day(2), s: 9, h: 1, purpose: 'x' })).s === 400);
    ok('approve by manager', (await call(mgr, '/api/act', { a: 'approve', id: sub.j.id })).s === 200);
    ok('no double booking', (await call(mgr, '/api/act', { a: 'approve', id: w.j.id })).s === 400);
    const ci = await call(asha, '/api/act', { a: 'ci', id: sub.j.id, c: 'Good', n: 'Bed clean' }); ok('check-in recorded', ci.s === 200);
    ok('return in worse condition', (await call(asha, '/api/act', { a: 'co', id: sub.j.id, c: 'Worn', n: 'Scratch on bed' })).s === 200);
    const inc = await call(mgr, '/api/act', { a: 'inc', id: sub.j.id, t: 'Damage', s: 'Low', d: 'Scratch on print bed' }); ok('incident reported', inc.s === 200);
    let st = (await call(mgr, '/api/state')).j; const n = st.inc[0];
    ok('student cannot decide incident', (await call(asha, '/api/act', { a: 'resolve', id: n.id, o: 'Dismissed', w: 'x' })).s === 403);
    ok('owner decides incident (human review)', (await call(owner, '/api/act', { a: 'resolve', id: n.id, o: 'Resolved: warning issued', w: 'First offence' })).s === 200);
    st = (await call(asha, '/api/state')).j; const b = st.bk.find(x => x.id === sub.j.id);
    ok('student sees condition records and history', b.ci.c === 'Good' && b.co.c === 'Worn' && st.audit.filter(e => e.ent === b.id).length >= 5);
    ok('student cannot see others bookings', st.bk.every(x => x.u === 'u1'));
    ok('overdue seed flagged by job', (await call(admin, '/api/state')).j.audit.some(e => e.act === 'overdue-flagged'));
    ok('waitlist promoted after cancel', (await call(owner, '/api/act', { a: 'cancel', id: 'B1' })).s === 200 && (await call(ravi, '/api/state')).j.bk.find(x => x.id === w.j.id).st !== 'waitlisted');
    // ---- uploads, email, AI assists, flags ----
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    ok('bad file type rejected', (await call(asha, '/api/upload', { data: 'data:text/html;base64,PGI+' })).s === 400);
    ok('fake image content rejected', (await call(asha, '/api/upload', { data: 'data:image/png;base64,AAAAAAAA' })).s === 400);
    const up = await call(asha, '/api/upload', { data: PNG }); ok('photo uploaded', up.s === 200);
    const s2 = await call(asha, '/api/act', { a: 'submit', r: 'r3', day: day(4), s: 9, h: 1, purpose: 'Photo test' });
    ok('attach photo at check-in', (await call(asha, '/api/act', { a: 'ci', id: s2.j.id, c: 'Good', n: 'ok', photos: [up.j.id] })).s === 200);
    ok('other photo claim blocked', (await call(ravi, '/api/act', { a: 'inc', id: 'B1', t: 'Damage', s: 'Low', d: 'x', photos: [up.j.id] })).s === 400);
    const fileGet = (tok, id) => fetch(base + '/api/file/' + id, { headers: { Authorization: 'Bearer ' + tok } });
    ok('owner/student can view photo', (await fileGet(asha, up.j.id)).status === 200 && (await fileGet(mgr, up.j.id)).status === 200);
    ok('other student cannot view photo', (await fileGet(ravi, up.j.id)).status === 404);
    ok('photo ids returned in state', (await call(asha, '/api/state')).j.bk.find(x => x.id === s2.j.id).ci.ph.length === 1);
    const ob = (await call(admin, '/api/state')).j; ok('email outbox logs notifications', ob.outbox.length > 0 && ob.outbox[0].st.startsWith('logged'));
    await call(asha, '/api/act', { a: 'mailpref' });
    await call(owner, '/api/act', { a: 'inc', id: sub.j.id, t: 'Misuse', s: 'Low', d: 'mail pref test' });
    const rows = (await call(admin, '/api/state')).j.outbox; ok('email opt-out respected', rows[0].to_ === 'manager@demo' && !rows[1].subject.includes('Incident reported'));
    const m = await call(asha, '/api/match', { need: 'I want to print an enclosure prototype' }); ok('smart match works offline', m.j.items[0].id === 'r1' && m.j.source === 'local' && m.j.items[0].elig === true);
    const sm = await call(owner, '/api/ai/summary?id=' + n.id); ok('incident summary for reviewer', sm.s === 200 && sm.j.text.includes('Damage'));
    ok('students cannot request summaries', (await call(asha, '/api/ai/summary?id=' + n.id)).s === 403);
    const pr = await call(asha, '/api/precheck?r=r1&day=' + day(3) + '&s=10&h=2'); ok('alternative slots suggested on conflict', pr.j.alts.length > 0 && pr.j.free === false);
    ok('no-show blocked before start', (await call(mgr, '/api/act', { a: 'noshow', id: s2.j.id })).s === 400);
    ok('flags endpoint for reviewers only', Array.isArray((await call(mgr, '/api/state')).j.flags) && (await call(asha, '/api/state')).j.flags.length === 0);
    ok('audit chain intact', (await call(admin, '/api/verify')).j.ok === true);
    console.log(`\nAll ${passed} checks passed`); process.exit(0);
  } catch (e) { console.error('\n' + (e.stack || e.message)); process.exit(1); }
})).catch(err => { console.error(err); process.exit(1); });
