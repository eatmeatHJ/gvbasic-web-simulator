"""Walk the line chain of a GVBASIC tokenized .BAS file.
Layout: [00] then repeated { u16 next-line-addr, u16 line-no, body..., 00 }, ending with next=0000.
The base address varies per file (0x7000, 0x1900, 0x0100...), so it is derived from the first pointer.
"""
def walk(d):
    # first line starts at file offset 1; its next-pointer minus its own end gives the base address
    off = 1
    first_next = d[off] | d[off + 1] << 8
    # find base so that the chain is self-consistent: try end offsets of first line
    z = d.index(0, off + 4)          # body can't contain 00 (strings don't either)
    base = first_next - (z + 1)
    out = []
    while True:
        nxt = d[off] | d[off + 1] << 8
        if nxt == 0:
            break
        ln = d[off + 2] | d[off + 3] << 8
        end = nxt - base
        assert d[end - 1] == 0, (off, end)
        out.append((ln, d[off + 4:end - 1]))
        off = end
    return out
