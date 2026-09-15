/* Delivery tracking for a retransmitted command.

   The pedal acknowledges each encapsulated 0x43 with an 0x41 naming the
   transaction id it received. A command that is retransmitted carries a new id
   each time, so delivery has to be judged across all of them: an 0x41 for any
   attempt proves the pedal took the frame, whenever it turns up.

   Before this, each attempt waited on its own id and deleted it on timeout, so
   an ack slower than the window satisfied nothing. On 2026-09-11 that aborted
   an install with "Pedal did not take delivery of f0 7e 00 06 01 f7" while the
   pedal acked the next command 37 ms later. */
const assert = require('node:assert/strict');

global.IAPCodec = { Parser: function () { this.feed = () => {}; }, frame: () => [] };
global.log = () => {};
require('./install.js');
const { delivery, fragmentAcks } = global.pedalCodec;

const ack = tr => { const done = fragmentAcks.get(tr); if (done) done(); return !!done; };
const idle = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // --- how it is actually used: one id, held across every attempt window ------
  // iAP1 R38 requires a retransmission to carry the same transaction id as the
  // packet it repeats, so a command registers exactly one id and each attempt is
  // another wait on it. An ack for the first transmission arriving during the
  // second attempt's window is therefore just an ack, with nothing to match up.
  {
    const d = delivery();
    d.sent(440);
    assert.equal(await d.wait(30), false, 'attempt 1 window closes unacknowledged');
    setTimeout(() => ack(440), 10);                // the pedal answers, late
    assert.equal(await d.wait(200), 440, 'the ack lands in attempt 2 and settles the delivery');
    d.release();
  }

  // --- a set of ids still settles on any one of them --------------------------
  // Nothing registers more than one id now, but the structure allows it.
  {
    const d = delivery();
    d.sent(440);
    assert.equal(await d.wait(20), false);
    d.sent(441);
    setTimeout(() => ack(440), 10);
    assert.equal(await d.wait(200), 440, 'an ack for any registered id settles it');
    d.release();
  }

  // --- the first ack wins, and later ones are harmless ----------------------
  {
    const d = delivery();
    d.sent(1); d.sent(2); d.sent(3);
    ack(2);
    assert.equal(await d.wait(50), 2);
    ack(1); ack(3);
    assert.equal(await d.wait(50), 2, 'the settled value does not change');
    d.release();
  }

  // --- genuine silence still fails -------------------------------------------
  {
    const d = delivery();
    d.sent(10);
    assert.equal(await d.wait(20), false);
    d.sent(11);
    assert.equal(await d.wait(20), false, 'no ack for any attempt is still a failure');
    d.release();
  }

  // --- release unregisters every id, so a later ack cannot fire a stale settle
  {
    const d = delivery();
    d.sent(20); d.sent(21);
    d.release();
    assert.equal(ack(20), false, 'released ids are gone from the ack table');
    assert.equal(ack(21), false);
    assert.equal(fragmentAcks.size, 0, 'no entries leak');
  }

  // --- transaction id 0 must not be mistaken for "no ack" --------------------
  {
    const d = delivery();
    d.sent(0);
    ack(0);
    const got = await d.wait(50);
    assert.notEqual(got, false, 'transaction 0 is a real id, not a falsy failure');
    assert.equal(got, 0);
    d.release();
  }

  // --- concurrent deliveries do not settle each other ------------------------
  {
    const a = delivery(), b = delivery();
    a.sent(100); b.sent(200);
    ack(200);
    assert.equal(await b.wait(50), 200);
    assert.equal(await a.wait(20), false, 'one delivery is not settled by another');
    a.release(); b.release();
    assert.equal(fragmentAcks.size, 0);
  }

  await idle(0);
  console.log('Delivery tracking: one id held across attempt windows, late acks counted, first ack wins, silence still fails, ids released, transaction 0 handled, deliveries isolated');
})();
