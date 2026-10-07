/* The data session's lifetime: opened for an operation, given back after it.

   WHY THIS EXISTS. The session used to be opened once and held until Disconnect,
   which made the whole connected period a window where a reload or a closed tab
   left the pedal holding a session for a host that was gone -- and that is the
   state nothing host-side clears, only a pedal power cycle (docs/bluetooth.md).
   Now pedalLock.run() takes one and gives it back, reference-counted.

   WHAT THIS CAN AND CANNOT PROVE. It stands in for the pedal, so it proves the
   bookkeeping: one open per operation, one close, nested work reusing the
   session rather than closing it early, a close even when the work throws, and
   no leak across repeated cycles. Whether the PEDAL accepts a second 0x3F after
   a 0x40 on the same link is a hardware question and this cannot answer it --
   see the checklist in docs/bluetooth.md. */
const assert = require('node:assert/strict');
global.window = global;
require('./pedal-lock.js');
const lock = global.pedalLock;

/* A stand-in for iapHost with the same contract: ensureSession() resolves once
   the pedal has acknowledged, withSession() reference-counts, closeSession() is
   a no-op when nothing is open. Mirrors iap.js rather than importing it,
   because iap.js needs a DOM, a transport and a live parser. */
function fakeHost({ refuse = false, openDelay = 0 } = {}) {
  const host = {
    session: null, identified: true, depth: 0, opens: 0, closes: 0, log: [],
    ensureSession() {
      if (host.session !== null) return Promise.resolve(host.session);
      if (!host.identified) return Promise.reject(Error('not identified'));
      host.opens++; host.log.push('open');
      return new Promise((resolve, reject) => setTimeout(() => {
        if (refuse) return reject(Error('refused'));
        host.session = 1; resolve(1);
      }, openDelay));
    },
    closeSession() {
      if (host.session === null) return Promise.resolve();
      host.closes++; host.log.push('close'); host.session = null;
      return Promise.resolve();
    },
    async withSession(fn) {
      host.depth++;
      try { await host.ensureSession(); return await fn(); }
      finally {
        host.depth--;
        if (host.depth <= 0) { host.depth = 0; if (host.session !== null) await host.closeSession(); }
      }
    },
  };
  return host;
}

async function main() {
  // --- one operation: open, work, close -----------------------------------
  {
    const host = fakeHost(); global.iapHost = host;
    let sawSession = null;
    const out = await lock.run('reading', async () => { sawSession = host.session; return 'done'; });
    assert.equal(out, 'done');
    assert.equal(sawSession, 1, 'the work ran with a session open');
    assert.equal(host.session, null, 'and the session was given back');
    assert.deepEqual(host.log, ['open', 'close']);
  }

  // --- nested work reuses the one session ---------------------------------
  // Restore holds the lock across fifty writes and each write asks for a
  // session; without reference counting the first write would close it for all
  // the rest.
  {
    const host = fakeHost(); global.iapHost = host;
    await lock.run('restoring', async () => {
      for (let i = 0; i < 3; i++)
        await lock.run(`writing ${i}`, async () => {
          assert.equal(host.session, 1, `write ${i} needs the session still open`);
        }, { nested: true });
    });
    assert.equal(host.opens, 1, 'one session for the whole restore');
    assert.equal(host.closes, 1, 'closed once, at the end');
    assert.equal(host.session, null);
  }

  // --- a failing operation still gives the session back -------------------
  {
    const host = fakeHost(); global.iapHost = host;
    await assert.rejects(() => lock.run('writing', async () => { throw Error('write failed'); }),
                         /write failed/);
    assert.equal(host.session, null, 'a thrown operation must not leak the session');
    assert.deepEqual(host.log, ['open', 'close']);
    assert.equal(lock.busy, false, 'and the lock is released too');
  }

  // --- a refused session surfaces, and leaves nothing held ----------------
  {
    const host = fakeHost({ refuse: true }); global.iapHost = host;
    let ran = false;
    await assert.rejects(() => lock.run('reading', async () => { ran = true; }), /refused/);
    assert.equal(ran, false, 'the work must not run without a session');
    assert.equal(host.session, null);
    assert.equal(host.closes, 0, 'nothing to close when the open was refused');
    assert.equal(lock.busy, false);
  }

  // --- a slow open still serialises correctly -----------------------------
  {
    const host = fakeHost({ openDelay: 20 }); global.iapHost = host;
    await lock.run('reading', async () => assert.equal(host.session, 1));
    assert.equal(host.opens, 1); assert.equal(host.closes, 1);
  }

  // --- repeated cycles do not leak ----------------------------------------
  {
    const host = fakeHost(); global.iapHost = host;
    for (let i = 0; i < 25; i++) await lock.run(`op ${i}`, async () => {});
    assert.equal(host.opens, 25); assert.equal(host.closes, 25);
    assert.equal(host.session, null); assert.equal(host.depth, 0);
  }

  // --- a host without withSession still works -----------------------------
  // The module loaded alone, or a test with a stubbed host: run() must not care.
  {
    global.iapHost = { session: null };
    assert.equal(await lock.run('reading', async () => 'ok'), 'ok');
    delete global.iapHost;
    assert.equal(await lock.run('reading', async () => 'ok'), 'ok');
  }

  console.log('Session lifecycle: one session per operation, reused when nested, returned on '
    + 'success, on failure and on refusal; 25 cycles leak nothing');
}

main().catch(e => { console.error(e); process.exit(1); });
