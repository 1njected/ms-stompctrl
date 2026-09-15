"""IDAPython: load the MS-100BT firmware with its real section layout.

    Processor:  TMS320C6   (NOT MetaPC -- that is x86)
    Format:     Binary file
    Endianness: little

MAIN.bin is a TIPA/YSX container: a chain of records, each `YSX`, a 4-byte load
address, a 4-byte length, the data, then one trailing byte. Ten sections cover
99% of the file. Loading the container raw puts everything at one address and
every cross-reference comes out wrong, so the sections have to be placed
individually.

USAGE

  1. Run firmware1.30/sections extraction first if the directory is missing:
         python3 runtime/ida-load-ms100bt.py --split path/to/MAIN.bin
  2. In IDA: File > Open > MAIN.bin, choose "Binary file", processor TMS320C6.
     Accept any load address; this script replaces the layout.
  3. File > Script file... > this script.

It deletes the initial flat segment, creates one segment per section at its real
address, loads the bytes, and marks the SysEx findings from docs/protocol.md.

There is no Hex-Rays decompiler for C6000. Disassembly only.
"""

SECTIONS = [
    # (file offset in MAIN.bin, load address, length, name)
    (0x000054, 0x11817000, 0x02ec0, "iram0"),
    (0x002f20, 0x11819ec0, 0x01480, "iram1"),
    (0x0043ac, 0x1181c340, 0x00480, "iram2"),
    (0x004838, 0xc00e1630, 0x00010, "ddr_head"),
    (0x004854, 0xc00e1640, 0x68460, "ddr_code"),   # the main 427 KB
    (0x06ccc0, 0xc0149aa0, 0x09da4, "ddr_data0"),
    (0x076a70, 0xc015d2ec, 0x00e34, "ddr_data1"),
    (0x0778b0, 0xc015e120, 0x002a0, "ddr_data2"),
    (0x077b5c, 0xc015e400, 0x00200, "ddr_data3"),
    (0x077d68, 0xc015efd0, 0x014e4, "ddr_data4"),
]

# Established in docs/firmware.md. The templates are literal
# `f0 52 ...` byte strings; the builder addresses are the single site that
# constructs each template's address from an mvk/mvklh pair.
TEMPLATES = [
    (0xc01531e0, 0x32, "STORE  f0 52 00 dd 32 01 00 00 <slot> 00*5 f7", 0xc00fadc8),
    (0xc0153358, 0x17, "cmd 17", 0xc00f9fc0),
    (0xc0153388, 0x06, "cmd 06", 0xc00f9d58),
    (0xc0153398, 0x31, "param edit", 0xc00fad34),
    (0xc01533e8, 0x60, "filesystem", 0xc010af80),
    (0xc0153478, 0x00, "cmd 00", 0xc00f9198),
    (0xc0153480, 0x20, "cmd 20", 0xc00fabec),
    (0xc0153488, 0x21, "cmd 21", 0xc00fac54),
    (0xc0153498, 0x04, "cmd 04", 0xc00faca8),
    (0xc01534a8, 0x05, "cmd 05", 0xc00facec),
]


def split(path):
    """Standalone: write firmware1.30/sections/*.bin next to MAIN.bin."""
    import pathlib
    src = pathlib.Path(path)
    data = src.read_bytes()
    out = src.parent / "sections"
    out.mkdir(exist_ok=True)
    for i, (off, addr, ln, name) in enumerate(SECTIONS):
        chunk = data[off:off + ln]
        assert len(chunk) == ln, f"{name}: short read"
        (out / f"{i:02d}_{addr:08x}_{ln:x}.bin").write_bytes(chunk)
        print(f"{name:10s} 0x{addr:08x}  {ln:#8x} bytes")
    print(f"\n{len(SECTIONS)} sections written to {out}")


def load_in_ida():
    import idaapi, idc, ida_bytes, ida_segment, ida_name

    path = idc.get_input_file_path()
    with open(path, "rb") as fh:
        data = fh.read()

    for seg in list(ida_segment.get_segm_qty() and
                    [ida_segment.getnseg(i) for i in range(ida_segment.get_segm_qty())]):
        if seg:
            ida_segment.del_segm(seg.start_ea, ida_segment.SEGMOD_KILL)

    for off, addr, ln, name in SECTIONS:
        is_code = "code" in name or "iram" in name
        idaapi.add_segm(0, addr, addr + ln, name, "CODE" if is_code else "DATA")
        ida_bytes.put_bytes(addr, data[off:off + ln])
        # add_segm leaves permissions clear, and IDA will not analyse a segment
        # it does not consider executable: auto-analysis finds zero functions and
        # every instruction query answers "no executable segments found".
        seg = ida_segment.getseg(addr)
        seg.perm = (ida_segment.SEGPERM_EXEC | ida_segment.SEGPERM_READ) if is_code \
            else (ida_segment.SEGPERM_READ | ida_segment.SEGPERM_WRITE)
        seg.update()
        print(f"{name:10s} 0x{addr:08x}-0x{addr + ln:08x}  {'rx' if is_code else 'rw'}")

    for tpl, cmd, note, builder in TEMPLATES:
        ida_name.set_name(tpl, f"sysex_tpl_{cmd:02x}", ida_name.SN_NOCHECK | ida_name.SN_FORCE)
        idc.set_cmt(tpl, note, 1)
        ida_name.set_name(builder, f"build_sysex_{cmd:02x}", ida_name.SN_NOCHECK | ida_name.SN_FORCE)
        idc.set_cmt(builder, f"builds {note}", 0)

    # Answered 2026-09-12: build_sysex_32 is the fallthrough TAIL of a function
    # that starts at 0xc00fada4, whose two callers are below. That settles who
    # sends 0x32; it does not settle whether a receive handler also exists.
    for addr, name in (
        (0xc00fada4, "send_sysex_32"),          # real entry; build_sysex_32 is its tail
        (0xc0121620, "send_sysex_32_for_patch"),  # loads patch no. from B14+0x468, bounds 50
        (0xc0121294, "patch_slots_clear"),      # 6 slots x 11 params
        (0xc012141c, "patch_record_copy"),      # 122-byte record, 11-byte name at +108
        (0xc00f09f4, "event_dispatcher"),       # 337 basic blocks; the only path to patch store
        (0xc00fb24c, "store_patch_and_notify"),  # calls send_sysex_32
    ):
        ida_name.set_name(addr, name, ida_name.SN_NOCHECK | ida_name.SN_FORCE)
        idaapi.add_func(addr)
    idc.set_cmt(0xc0121620, "MVK 50 / MVK 51 here are the patch-count bound, "
                            "NOT the command bytes 0x32/0x33", 0)
    idc.set_cmt(0xc00f09f4, "Dispatches internal events 20/21/22, 41-4A (table at "
                            "0xc015dd54), A0/A1/A2, E0, E3. NOT SysEx commands -- A0, E0 "
                            "and E3 exceed 0x7F. Statically unreachable: no stored "
                            "pointer, no MVK/MVKH pair, no PC-relative branch anywhere "
                            "in the image. See runtime/fw-xref-scan.py", 0)
    ida_name.set_name(0xc015dd54, "event_jumptable_41_4A",
                      ida_name.SN_NOCHECK | ida_name.SN_FORCE)
    idaapi.auto_mark_range(0xc00e1640, 0xc0149aa0, idaapi.AU_CODE)
    idaapi.auto_wait()
    print("\nSections placed, permissions set, analysis run, SysEx sites named.")
    print("Now: go to build_sysex_32 (0xc00fadc8), find the containing function,")
    print("and take xrefs-to on it. That is the open question.")


if __name__ == "__main__":
    import sys
    if "--split" in sys.argv:
        split(sys.argv[sys.argv.index("--split") + 1])
    else:
        try:
            load_in_ida()
        except ImportError:
            print(__doc__)
            print("Not running inside IDA. Use --split <MAIN.bin> to extract sections.")
