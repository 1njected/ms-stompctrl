/* FLST_SEQ.ZDT — the MS-100BT's effect list.

   Decoded from a native StompShare install captured on the iPad: the file is a
   flat array of 316 fixed 13-byte records, 4,108 bytes in total.  A record is
   one of

     >>> \0 <id> 00 ...    category start marker
     <<< \0 <id> 00 ...    category end marker
     NAME.ZDL \0 ...       an effect, NUL-padded to 13 bytes
     00 x13                unused slot

   Installing an effect inserts one record immediately after its category's
   start marker, shifting the remainder down and consuming one trailing unused
   slot.  The category is the high byte of the effect ID, the ZDL metadata word
   at offset 0x40; that rule matched all 103 listed effects with no exceptions.

   The pedal will not show an effect that is on its filesystem but absent from
   this list: it stays on "Now loading". */
(function (g) {
  const RECORD = 13, TOTAL = 316, SIZE = RECORD * TOTAL;
  const isStart = r => r[0] === 0x3e && r[1] === 0x3e && r[2] === 0x3e;
  const isEnd = r => r[0] === 0x3c && r[1] === 0x3c && r[2] === 0x3c;
  const isFree = r => r.every(x => x === 0);
  const nameOf = r => { let s = ''; for (const c of r) { if (!c) break; s += String.fromCharCode(c); } return s; };

  const toRecords = bytes => {
    const out = [];
    for (let i = 0; i + RECORD <= bytes.length; i += RECORD) out.push(Array.from(bytes.slice(i, i + RECORD)));
    return out;
  };
  const serialize = recs => {
    const out = [];
    for (const r of recs) out.push(...r);
    return Uint8Array.from(out);
  };
  const record = text => {
    const b = Array.from(new TextEncoder().encode(text));
    if (b.length > RECORD) throw Error(`Effect list entry too long: ${text}`);
    while (b.length < RECORD) b.push(0);
    return b;
  };

  /* Categories, in file order, each with its effect filenames. */
  function categories(bytes) {
    const cats = [];
    let cur = null;
    for (const r of toRecords(bytes)) {
      if (isStart(r)) { cur = { id: r[4], files: [] }; cats.push(cur); }
      else if (isEnd(r)) cur = null;
      else if (!isFree(r) && cur) cur.files.push(nameOf(r));
    }
    return cats;
  }

  const entries = bytes => categories(bytes).flatMap(c => c.files);

  /* Category for an effect, from the ZDL metadata word at 0x40. */
  function categoryOf(zdl) {
    if (zdl.length < 0x44) throw Error('ZDL too short to contain an effect ID');
    const id = zdl[0x40] | (zdl[0x41] << 8) | (zdl[0x42] << 16) | (zdl[0x43] << 24);
    return { effectId: id >>> 0, category: (id >>> 24) & 0xff };
  }

  /* Insert one effect, returning a new 4,108-byte list. */
  function insert(bytes, filename, category) {
    const recs = toRecords(bytes);
    if (bytes.length !== SIZE || recs.length !== TOTAL)
      throw Error(`Unexpected effect list size: ${bytes.length} bytes, expected ${SIZE}`);
    if (entries(bytes).some(f => f.toUpperCase() === filename.toUpperCase()))
      return { bytes, changed: false, reason: 'already listed' };
    const at = recs.findIndex(r => isStart(r) && r[4] === category);
    if (at < 0) throw Error(`Effect list has no category ${category}`);
    if (!isFree(recs[TOTAL - 1]))
      throw Error('Effect list is full; no unused slot to consume');
    const out = recs.slice(0, at + 1).concat([record(filename)], recs.slice(at + 1, TOTAL - 1));
    const result = serialize(out);
    if (result.length !== SIZE) throw Error(`Serialized ${result.length} bytes, expected ${SIZE}`);
    return { bytes: result, changed: true, category, index: at + 1 };
  }

  /* Remove one effect, returning a new 4,108-byte list.  The exact inverse of
     insert: the records below it shift up and a free slot is appended, so the
     file keeps its 316 records and every category marker keeps its order. */
  function remove(bytes, filename) {
    const recs = toRecords(bytes);
    if (bytes.length !== SIZE || recs.length !== TOTAL)
      throw Error(`Unexpected effect list size: ${bytes.length} bytes, expected ${SIZE}`);
    const at = recs.findIndex(r => !isFree(r) && !isStart(r) && !isEnd(r) &&
                                   nameOf(r).toUpperCase() === filename.toUpperCase());
    if (at < 0) return { bytes, changed: false, reason: 'not listed' };
    const out = recs.slice(0, at).concat(recs.slice(at + 1), [new Array(RECORD).fill(0)]);
    const result = serialize(out);
    if (result.length !== SIZE) throw Error(`Serialized ${result.length} bytes, expected ${SIZE}`);
    return { bytes: result, changed: true, index: at };
  }

  g.FlstCodec = { RECORD, TOTAL, SIZE, categories, entries, categoryOf, insert, remove, toRecords, serialize, record, isFree, isStart, isEnd, nameOf };
})(typeof globalThis !== 'undefined' ? globalThis : this);
