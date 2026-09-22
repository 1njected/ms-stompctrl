(function (g) {
  const state = g.pedalInventory = { files: [], running: false };
  let pending = null, buf = [];
  const parse = f => f[4] === 0x60 && f[5] === 4 && f[6] === 0x25
    ? { filename: String.fromCharCode(...f.slice(15, 27)).split('\0')[0], bytes: f.slice(30, 35).reduce((n, v, i) => n + v * 2 ** (7 * i), 0) }
    : null;
  // An iAP retransmission repeats the transaction id of the packet it repeats.
  // The pedal re-sends when our ack is not reaching it: measured 2026-09-13, one
  // 0x42 arrived 11 times in 5 s while every write of ours was being buffered
  // and dropped. Without this guard each copy was appended to the file list, so
  // a stall silently duplicated entries in the inventory rather than failing.
  // Matched on the bytes as well as the id, not the id alone: a SysEx payload may
  // span several 0x42 frames, and those must still be reassembled. A genuine
  // retransmission repeats the whole packet, so this stays exact.
  let lastPayload = null, lastBytes = null, repeats = 0;
  const parser = new IAPCodec.Parser(p => {
    if (p.lingo !== 0 || p.data[0] * 256 + p.data[1] !== iapHost.session) return;
    const bytes = p.data.join(',');
    if (p.transaction === lastPayload && bytes === lastBytes) {
      if (++repeats === 3) old('link_one_way', { transaction: p.transaction, hint: 'The pedal keeps re-sending one frame, so our acknowledgements are not reaching it. Host-to-pedal writes are being buffered and dropped. Measured to recover on its own within a few seconds.' });
      return;
    }
    lastPayload = p.transaction; lastBytes = bytes; repeats = 0;
    for (const b of p.data.slice(2)) {
      if (b === 240) buf = [];
      buf.push(b);
      if (b !== 247) continue;
      const f = buf; buf = []; const item = parse(f);
      if (item) state.files.push(item);
      // The pedal uses an independent transaction sequence for 0x42 payloads
      // (for example, request 0x43/transaction 2 is answered by 0x42/transaction
      // 1). Requests are serialized, so the first matching session payload is
      // the response to the pending inventory command.
      if (pending) { const done = f[4] === 0x60 && f[5] === 3; const resolve = pending.resolve; pending = null; resolve(done); }
    }
  });
  // The accessory acknowledges every encapsulated 0x43 with 0x41, so the host can
  // tell whether a command was actually delivered.  install.js has used this
  // since fcb3b2c and it took installs from 50% to 87.5%; the scan had no such
  // check, so a lost command truncated the directory listing with no indication
  // why.  Re-sending is safe because it is conditional on the missing 0x41: no
  // 0x41 means the pedal never received the frame, so it cannot act on it twice.
  const receipts = new Map();
  // Every attempt at one command carries a fresh transaction id, and an 0x41 for
  // any of them proves delivery -- including one that arrives after the attempt
  // that sent it gave up.  Waiting on a single id and dropping it on timeout
  // made a late ack worthless, which aborted an install on 2026-09-11 while the
  // pedal was demonstrably answering.  Same defect, same fix as install.js.
  function delivery() {
    const ids = new Set();
    let settle;
    const acked = new Promise(r => { settle = r; });
    return {
      sent(tr) { ids.add(tr); receipts.set(tr, () => settle(tr)); },
      wait(ms) { return Promise.race([acked, new Promise(r => setTimeout(() => r(false), ms))]); },
      release() { for (const tr of ids) receipts.delete(tr); }
    };
  }
  const receiptParser = new IAPCodec.Parser(p => {
    if (p.lingo !== 0 || p.cmd !== 0x41 || p.data[1] !== 0x43) return;
    const done = receipts.get(p.transaction);
    if (done) done();
  });
  const old = g.log;
  g.log = (k, v) => { old(k, v); if (k === 'rx') { const b = v.split(' ').map(x => parseInt(x, 16)); receiptParser.feed(b.slice()); parser.feed(b); } };
  async function send(data) {
    return stompTransfer(()=>sendExclusive(data));
  }
  // Two independent clocks, because they fail for different reasons. DELIVERY is
  // "did the frame reach the pedal at all"; on 2026-09-13 that stalled for 5 s
  // while the pedal was demonstrably alive and sending. RESPONSE is "did the
  // pedal answer the command". Running one 8 s budget across both meant a
  // delivery stall spent the response budget, and a scan that would have
  // completed died with "Inventory response timeout" seconds after the link came
  // back. The response window now starts when the pedal confirms delivery.
  // On `state` so tests can shrink them; read at call time, never captured.
  const timing = state.timing = {
    deliveryWaits: [2500, 3000, 4000, 5000],   // 14.5 s, clears the measured 5 s stall
    responseMs: 8000
  };
  async function sendExclusive(data) {
    let resolveResponse, rejectResponse;
    const result = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
    result.catch(() => {});
    pending = { resolve: resolveResponse };
    let timer = null;
    const armResponse = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (pending?.resolve === resolveResponse) { pending = null; rejectResponse(Error('Inventory response timeout')); }
      }, timing.responseMs);
    };
    // Deliberately NOT armed yet. The delivery loop below is separately bounded,
    // so nothing can hang here, and arming now would re-create the original
    // defect: the response fuse burning down during a delivery stall. `pending`
    // is already set, so a payload that arrives early is still captured.
    // One transaction id for the packet, reused on every retransmission: the
    // accessory deduplicates on it, so a retry under a fresh id reads as new
    // data rather than a repeat. iAP1 R38; see docs/iap-audit.md.
    const post = delivery(), transaction = iapHost.nextTransaction++;
    post.sent(transaction);
    const frame = IAPCodec.frame(0x43, transaction, [iapHost.session >> 8, iapHost.session & 255, ...data]);
    const sysex = data.map(x => x.toString(16).padStart(2, '0')).join(' ');
    let acked = false;
    try {
      for (let attempt = 1; attempt <= timing.deliveryWaits.length && acked === false; attempt++) {
        old('inventory_tx', { transaction, attempt, sysex });
        await stompWrite(frame, 'inventory');
        acked = await post.wait(timing.deliveryWaits[attempt - 1]);
        if (acked === false) old('inventory_retransmit', { attempt, waited: timing.deliveryWaits[attempt - 1], sysex });
        else if (attempt > 1) old('late_ack_recovered', { transaction, attempt });
      }
    } finally { post.release(); }
    if (acked === false) { clearTimeout(timer); pending = null; throw Error('Pedal did not take delivery of an inventory command'); }
    armResponse();   // the pedal has it now; give the answer a full window from here
    try {
      let done;
      // Delivery confirmed but no answer is a distinct, actionable state that
      // no retry can clear; see stompSilence in transport.js.
      try { done = await result; }
      catch (e) {
        const n = globalThis.stompSilence?.delivered?.() ?? 0;
        throw /response timeout/i.test(String(e)) && n ? Error(globalThis.stompSilence.message()) : e;
      }
      globalThis.stompSilence?.answered();
      await new Promise(r => setTimeout(r, 100));
      return done;
    }
    finally { clearTimeout(timer); }
  }
  /* A directory scan is the longest conversation this client has with the
     pedal, so it holds the operation lock for the whole sweep. */
  state.run = (opts = {}) => g.pedalLock.run('reading the effect list', () => scanNow(), opts);
  const scanNow = async () => {
    if (state.running || iapHost.session === null) return state.files;
    state.running = true; state.files = [];
    try {
      await send([240, 82, 0, 94, 0x60, 6, 247]);
      await send([240, 82, 0, 94, 0x60, 0x25, 0, 0, 0x2a, 0x2e, 0x2a, ...Array(10).fill(0), 247]);
      for (let i = 0; i < 120; i++) if (await send([240, 82, 0, 94, 0x60, 0x26, 247])) break;
      await send([240, 82, 0, 94, 0x60, 0x27, 247]);
    } catch (e) { old('inventory_error', String(e)); }
    finally {
      // Native StompShare closes the search, unmutes audio, and releases the
      // FFS semaphore. Without this, a following effect install is ignored as
      // a busy filesystem operation.
      for (const [data, match] of [
        [[240, 82, 0, 94, 0x60, 1, 1, 247], f => f[4] === 0x60 && f[5] === 5],
        [[240, 82, 0, 94, 0x61, 6, 247], f => f[4] === 0 && f[5] === 0],
        [[240, 82, 0, 94, 0x60, 7, 247], f => f[4] === 0x60 && f[5] === 5]
      // Each step is independent and the semaphore release is LAST, so breaking on
      // the first failure guaranteed the one that matters never ran -- which is
      // exactly the "busy filesystem" wedge the comment above warns about. Try
      // all three however badly the previous one went.
      ]) { try { await send(data); } catch (e) { old('inventory_cleanup_error', String(e)); } }
    }
    state.running = false; return state.files;
  };
})(globalThis);
