/* Inventory survival under a one-way link stall.

   Measured 2026-09-13: while scanning, host->pedal delivery stopped for ~5 s.
   The pedal was plainly alive -- it re-sent one 0x42 eleven times because none
   of our acknowledgements were reaching it -- and the link then recovered by
   itself. The scan died anyway, and left the pedal's filesystem semaphore held.
   These tests pin the four defects that made that outcome inevitable. */
const assert = require('node:assert/strict');

require('./iap.js');                                   // IAPCodec only; no DOM path in node
const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join(' ');
const SESSION = 1;

// One real captured directory record, ARENA.ZDL.
const RECORD = ('f0 52 00 5e 60 04 25 00 00 17 00 00 00 00 00 41 52 45 4e 41 2e 5a 44 4c 00 00 00 '
  + '28 00 00 69 7f 00 00 00 00 00 00 00 00 f7').split(' ').map(x => parseInt(x, 16));
const DONE = [0xf0, 0x52, 0x00, 0x5e, 0x60, 0x03, 0xf7];   // "no more entries"

const logged = [];
global.log = (k, v) => logged.push({ k, v });
global.iapHost = { session: SESSION, nextTransaction: 1 };
global.stompTransfer = fn => fn();

let writes = [], deliver = true;
global.stompWrite = bytes => { writes.push(bytes); return Promise.resolve(); };

require('./inventory.js');
const inv = global.pedalInventory;
inv.timing.deliveryWaits = [40, 40, 40, 40];
inv.timing.responseMs = 300;

const feed = bytes => global.log('rx', hex(bytes));
const payload = (tr, sysex) => IAPCodec.frame(0x42, tr, [SESSION >> 8, SESSION & 255, ...sysex]);
const receipt = tr => IAPCodec.frame(0x41, tr, [0x00, 0x43]);
const idle = ms => new Promise(r => setTimeout(r, ms));
const kinds = () => logged.map(e => e.k);

// The pedal answers whatever the host last sent, once, after `lag` ms.
function autoRespond({ lag = 5, reply = RECORD, stalled = () => false } = {}) {
  let seen = 0;
  return setInterval(() => {
    if (writes.length === seen) return;
    const frame = writes[writes.length - 1]; seen = writes.length;
    if (stalled()) return;                              // frame never reaches the pedal
    const tr = frame[4] * 256 + frame[5];
    setTimeout(() => { feed(receipt(tr)); feed(payload(0x200 + tr, reply)); }, lag);
  }, 5);
}

(async () => {
  // --- a retransmitted payload must not be counted twice ---------------------
  // The storm delivered 11 copies of one record. Each was appended, so a stall
  // silently inflated the inventory instead of failing.
  {
    logged.length = 0; writes = [];
    const pump = autoRespond();
    const scan = inv.run();
    await idle(30);
    const dup = payload(0x999, RECORD);
    feed(dup); feed(dup); feed(dup); feed(dup);          // four identical copies
    await idle(30);
    clearInterval(pump);
    await scan.catch(() => {});
    const arenas = inv.files.filter(f => f.filename === 'ARENA.ZDL');
    assert.ok(arenas.length >= 1, 'the first copy is still recorded');
    const fromDup = inv.files.filter((f, i, a) => a.findIndex(x => x.filename === f.filename) !== i
      && f.filename === 'ARENA.ZDL').length;
    assert.ok(fromDup < 4, `retransmissions must not each append a file (saw ${inv.files.length} entries)`);
    assert.ok(kinds().includes('link_one_way'), 'a repeated transaction is reported as a one-way link');
  }

  // --- delivery stalling must not consume the response budget ----------------
  // The old code ran one 8 s clock across both, so a delivery stall guaranteed
  // "Inventory response timeout" even when the link came back in time.
  {
    logged.length = 0; writes = []; deliver = false;
    inv.timing.responseMs = 120;                        // shorter than the stall below
    const pump = autoRespond({ stalled: () => !deliver });
    setTimeout(() => { deliver = true; }, 100);         // link recovers mid-command
    const scan = inv.run();
    await idle(600);
    clearInterval(pump);
    await scan.catch(() => {});
    const errs = logged.filter(e => e.k === 'inventory_error').map(e => String(e.v));
    assert.ok(!errs.some(e => /response timeout/i.test(e)),
      'a delivery stall shorter than the retry budget must not surface as a response timeout: ' + errs.join('; '));
    assert.ok(kinds().includes('inventory_retransmit'), 'the stall was actually exercised');
  }

  // --- cleanup must always reach the semaphore release -----------------------
  // The three cleanup steps are independent and `60 07` (release) is LAST, so
  // breaking on the first failure guaranteed the pedal stayed wedged.
  {
    logged.length = 0; writes = []; deliver = true;
    inv.timing.deliveryWaits = [10, 10];
    inv.timing.responseMs = 40;
    const pump = autoRespond({ stalled: () => true });   // nothing is ever delivered
    const scan = inv.run();
    await idle(900);
    clearInterval(pump);
    await scan.catch(() => {});
    const sent = logged.filter(e => e.k === 'inventory_tx').map(e => e.v.sysex);
    for (const step of ['60 01 01', '61 06', '60 07']) {
      assert.ok(sent.some(x => x.includes(step)),
        `cleanup step ${step} must be attempted even after earlier steps fail`);
    }
  }

  // --- delivered but unanswered is reported as its own state ----------------
  // Measured live 2026-09-13: the pedal acknowledged every 0x43 within ~40 ms
  // while answering nothing from any subsystem -- filesystem, audio, patch and
  // identity alike. Only a power cycle clears that, so it must not be reported
  // as a write/response timeout, which reads as a link fault and sends you
  // looking in the wrong place.
  {
    logged.length = 0; writes = []; deliver = true;
    inv.timing.deliveryWaits = [30, 30];
    inv.timing.responseMs = 60;
    global.stompSilence = {
      count: 0,
      delivered() { return ++this.count; },
      answered() { this.count = 0; },
      message() { return this.count >= 2 ? 'APP-LAYER-STOPPED' : 'TOOK-BUT-NO-ANSWER'; }
    };
    // The pedal acks receipt of every command and never sends a payload.
    let seen = 0;
    const pump = setInterval(() => {
      if (writes.length === seen) return;
      const frame = writes[writes.length - 1]; seen = writes.length;
      const tr = frame[4] * 256 + frame[5];
      setTimeout(() => feed(receipt(tr)), 3);           // 0x41 only, never 0x42
    }, 5);
    const scan = inv.run();
    await idle(900);
    clearInterval(pump);
    await scan.catch(() => {});
    const errs = logged.filter(e => /inventory_error|cleanup_error/.test(e.k)).map(e => String(e.v));
    assert.ok(errs.length, 'the scan did fail');
    assert.ok(errs.some(e => e.includes('APP-LAYER-STOPPED')),
      'a run of delivered-but-unanswered commands must report the application layer as stopped, got: ' + errs.join('; '));
    assert.ok(!errs.some(e => /did not take delivery/i.test(e)),
      'delivery succeeded, so it must not be reported as undelivered');
    assert.ok(global.stompSilence.count >= 2, 'the silence run was actually counted');
  }

  // A pedal that answers must clear the counter, or one slow command would
  // poison every later error message with a power-cycle instruction.
  {
    logged.length = 0; writes = []; deliver = true;
    global.stompSilence.count = 5;
    inv.timing.deliveryWaits = [40, 40, 40, 40];
    inv.timing.responseMs = 300;
    const pump = autoRespond();
    const scan = inv.run();
    await idle(120);
    clearInterval(pump);
    await scan.catch(() => {});
    assert.equal(global.stompSilence.count, 0, 'an answered command resets the silence counter');
  }

  console.log('inventory.test.cjs: all assertions passed');
})().catch(e => { console.error(e); process.exit(1); });
