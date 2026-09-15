"""Decode captured StompShare directory queries; validate against app results."""
import collections
import json
import pathlib
import sys

source = pathlib.Path(sys.argv[1])
records = [json.loads(line) for line in source.read_text().splitlines()]
frames, entries = [], []
pending = {'tx': bytearray(), 'rx': bytearray()}
fragment_counts = collections.Counter()

def u32(data):
    assert len(data) == 5 and all(b < 128 for b in data)
    return sum(b << (7 * i) for i, b in enumerate(data)) & 0xffffffff

for record in records:
    payload = record['message'].get('payload', {})
    if payload.get('kind') != 'packet_fragment':
        continue
    direction = payload['direction']
    fragment_counts[direction] += 1
    data = bytes.fromhex(record['hex'])
    assert len(data) == payload['length']
    for byte in data:
        if byte >= 0xf8:  # MIDI realtime bytes may interleave SysEx.
            continue
        buf = pending[direction]
        if byte == 0xf0:
            assert not buf, 'Unfinished SysEx before new start'
        else:
            assert buf, 'Byte outside SysEx'
        buf.append(byte)
        if byte != 0xf7:
            continue
        b = bytes(buf)
        buf.clear()
        frame = dict(index=len(frames), direction=direction,
                     time=payload['time'], length=len(b), hex=b.hex(' '))
        if b[:5] == bytes.fromhex('f0 7e 00 06 02'):
            frame.update(kind='identity_reply', manufacturer=b[5], device_id=b[6],
                         firmware=b[10:14].decode('ascii'))
        elif b[:5] == bytes.fromhex('f0 52 00 5e 60'):
            frame['command'] = f'{b[5]:02x}'
            if direction == 'rx' and b[5] == 4 and b[6] in (0x25, 0x26):
                assert len(b) == 41
                entry = dict(name=b[15:27].split(b'\0')[0].decode('ascii'), size=u32(b[30:35]))
                frame.update(kind='directory_entry', entry=entry)
                entries.append(entry)
            elif direction == 'rx' and b[5:7] == bytes([4, 0x29]):
                frame.update(kind='disk_space', total=u32(b[11:16]), free=u32(b[16:21]))
            elif direction == 'rx' and b[5] == 3:
                value = u32(b[6:11])
                frame.update(kind='filesystem_result', result=value if value < 2**31 else value - 2**32)
        frames.append(frame)
assert not any(pending.values()), 'Incomplete final frame'
query = next(r['message']['payload']['value'] for r in records
             if r['message'].get('payload', {}).get('kind') == 'query_result')
assert all(query[k] for k in ('identity', 'files', 'disk'))
assert entries == [dict(name=e['name'], size=int(e['size'])) for e in query['entries']]
disk = next(f for f in frames if f.get('kind') == 'disk_space')
assert (disk['total'], disk['free']) == (int(query['diskTotal']), int(query['diskFree']))
assert all(f['direction'] == ('tx' if i % 2 == 0 else 'rx') for i, f in enumerate(frames))
# This recording must contain only these observed query/setup/teardown commands.
allowed = {(0x60, c) for c in (6, 7, 0x25, 0x26, 0x27, 0x29, 5, 1)} | {(0x61, 6)}
for f in frames:
    b = bytes.fromhex(f['hex'])
    if f['direction'] == 'tx' and b[:4] == bytes.fromhex('f0 52 00 5e'):
        assert (b[4], b[5]) in allowed
result = dict(source=source.name, fragments=dict(fragment_counts), frames=frames,
              installed_files=entries, disk=dict(total=disk['total'], free=disk['free']),
              validation='Decoded directory and disk values exactly match app query results.')
source.with_suffix('.decoded.json').write_text(json.dumps(result, indent=2) + '\n')
lines = ['# Recorded MS-100BT protocol', '',
         f'Source: `{source.name}`. {len(frames)} complete SysEx frames; {dict(fragment_counts)} fragments.',
         'Decoded names, sizes, and disk values exactly match the app’s parsed results.', '',
         f'Firmware: **1.30**. Files: **{len(entries)}**. Disk total: **{disk["total"]} bytes**; free: **{disk["free"]} bytes**.', '',
         'Read-only identity, directory, and disk query. No effect or firmware write was requested.', '',
         '## Installed files', '', '| File | Bytes |', '|---|---:|']
lines += [f'| {e["name"]} | {e["size"]} |' for e in entries]
lines += ['', '## Complete frame transcript', '', 'Times are device-side UTC timestamps at the transport hooks.', '', '```text']
lines += [f'{f["index"]:03} {f["time"]} {f["direction"]} {f["hex"]}' for f in frames]
lines += ['```', '']
source.with_suffix('.md').write_text('\n'.join(lines))
print(json.dumps(dict(frames=len(frames), fragments=dict(fragment_counts), files=len(entries), disk=result['disk'], validation=result['validation'])))
