# iAP1 audit of `iap.js`, `install.js` and `inventory.js`

Done 2026-09-11 against the *iPod Accessory Protocol Interface Specification* R38 (Apple, 2009),
read from the copy on archive.org (`ipod-accessory-protocol-interface-specification`). Rules below
are paraphrased, not reproduced.

Context: the host side is clean — 822 writes across two failing installs, zero backpressure, worst
`ready` 1.6 ms — so any fault is at or above iAP, in code we own. This is a read of that layer
against the specification rather than against observed behaviour.

We act as the **iPod**; the MS-100BT is the **accessory**. So we send `0x43 iPodDataTransfer` and
`0x02 ACK`; it sends `0x41 DevACK` and `0x42 DevDataTransfer`.

---

## What the spec confirms we already do correctly

- **`0x02` is the right acknowledgement for `0x42`.** The command reference for `DevDataTransfer`
  states the iPod answers with a General lingo ACK. This was reached by experiment — trying
  `0x41` instead and measuring it much worse — and the spec agrees. That row is settled.
- **Framing.** Sync `0x55`, small and large length forms, payload of lingo + command + transaction +
  data, and a checksum over length-through-payload that makes the run sum to zero modulo 256.
  `IAPCodec.frame` and `Parser` both match.
- **Transaction IDs are in use** and sit where we put them. IDPS requires them, and the pedal's
  replies decode correctly on that assumption.
- **`0x43` is answered by a `DevACK` carrying command ID `0x43` and the transaction ID we sent.**
  That is exactly the ack `delivery()` waits for.

## Deviations, most consequential first

### 1. A retransmitted packet must reuse its transaction ID. We allocate a new one.

The data-session rules state it twice, once for each direction: on timeout the sender resends the
same packet with the same transaction ID. `exchange`, `exchangeFragmented` and `inventory.js` all
do `iapHost.nextTransaction++` per attempt, so every retry is, to the accessory, a brand-new packet.

That ID is how the accessory deduplicates. Retrying under a new one means a `60 23` fragment the
pedal *did* receive the first time is appended to the file a second time. This was recorded
that duplicate-fragment risk as residual and unsolved; the spec's answer is the transaction ID, and
we are not using it. It is also why a late `0x41` was unmatchable — the design assumes one ID per
logical packet, so there is nothing to match against but the one we threw away.

### 2. We acknowledge the accessory's acknowledgements.

`iap.js` replies to every `0x41 DevACK` with an `0x02`. The specification describes `DevACK` as the
accessory's response to certain iPod commands and nowhere provides for the iPod to acknowledge one;
the `0x43` rule is simply that the accessory must answer with a `DevACK`. The exchange ends there.

This is roughly half of everything we transmit — in the failing install, 652 outbound iAP frames for
308 commands.

**A mechanism worth testing.** Our transaction counter and the pedal's are independent sequences
that both start low and overlap for the early part of a session. Our ack of a `DevACK` carries
*our* command's transaction ID. If the pedal matches an incoming `0x02` by transaction ID, a
spurious ack can collide with one of its own outstanding `DevDataTransfer` IDs — corrupting exactly
the bookkeeping that decides whether a window has been acknowledged, which is what the stall looks
like. Speculative, but cheap to test, and a deviation either way.

The comment defending this behaviour says inventory requests time out without it. That observation
predates the delivery-tracking fix, which is precisely the bug that would have made removing it look
like a regression.

### 3. Retry timing is wrong in both directions.

Spec: a 500 ms timeout before retransmitting, up to ten retries, after which the session may be
closed. Ours: 2,500 ms for commands, 4,000 ms for fragments, three attempts. We wait five times too
long and give up three times too early. The pedal's own retransmit cadence — measured at 0.48–0.55 s
as measured — is this same rule, so 500 ms is demonstrably the number the firmware works to.

### 4. We ignore the maximum payload the accessory advertises.

The pedal sends an `AccInfoToken` (FID type 0, subtype 2) with `accInfoType 0x09` and value
`0f b0` — **4,016 bytes**. `iap.js` acknowledges the token and discards the value.

The default without that token is 1,018 bytes, and payload length counts lingo, command, transaction,
session and data together. Our fragments are 1,024 data bytes plus six of header, so 1,030 — *over
the default*, legal only because the pedal happens to raise the ceiling. We are inside the limit by
luck rather than by reading it.

`maxPayload=1024` in `exchangeFragmented` was arrived at experimentally and its comment theorises a
4,096-byte transport boundary. The negotiated figure is 4,016, which would send a 4,704-byte write
packet as two fragments instead of five.

### 5. Smaller items

- **Flow control is unimplemented.** The iPod is supposed to send `0x4A iPodNotification` when its
  input queue overflows, telling the accessory to pause — including retries — and returning the
  transaction ID that overflowed so the accessory knows what to resend. We never send one. We are
  not overflowing, so this is an unmet obligation rather than an active fault.
- **ACK status is always 0.** The spec defines `0x01` for a `DevDataTransfer` on a closed or unknown
  session and `0x02` for one the accessory never successfully acknowledged. We always answer 0.
- **`0x12` advertises 4,096** as our transport maximum payload (`send(0x12,...,[0x10,0])`). A
  different quantity from item 4, and apparently never examined; worth checking against the `0x12`
  command reference.

---

These are deviations from the specification, listed most consequential first. They are recorded as
known gaps rather than as a work plan; the client is interoperable with this pedal as it stands.
