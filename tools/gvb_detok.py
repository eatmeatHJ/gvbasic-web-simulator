"""Convert a GVBASIC tokenized .BAS file back to readable text.

Usage:  python gvb_detok.py FILE.BAS [-o OUT.txt]      (UTF-8 output)
        python gvb_detok.py --all DIR OUTDIR

File layout (Applesoft-style linked lines):
    00
    repeat { u16 next-line-address, u16 line-number, body..., 00 }
    u16 0000
The address base differs per file (0x7000 here, 0x1900 in other programs), so it is
derived from the first pointer. Body bytes: >= 0x80 keyword token, 0x1F + 2 bytes = one
double-byte (Big5) character, anything else literal ASCII. Strings are never tokenized.
"""
import argparse, io, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
TOKENS = {int(k, 16): v for k, v in json.load(open(os.path.join(HERE, "gvb_tokens.json"), encoding="utf-8")).items() if not k.startswith("_")}


def walk(d):
    off = 1
    nxt = d[off] | d[off + 1] << 8
    base = nxt - (d.index(0, off + 4) + 1)
    lines = []
    while True:
        nxt = d[off] | d[off + 1] << 8
        if nxt == 0:
            break
        ln = d[off + 2] | d[off + 3] << 8
        end = nxt - base
        if d[end - 1] != 0:
            raise ValueError("broken line chain at file offset %d" % off)
        lines.append((ln, d[off + 4:end - 1]))
        off = end
    return lines


def dbcs(hi, lo):
    try:
        return bytes((hi, lo)).decode("cp950")
    except UnicodeDecodeError:
        return "{%02X%02X}" % (hi, lo)   # device-specific glyph (private use area)


def detok_line(b):
    out = []
    i, n = 0, len(b)
    in_str = False
    raw = False                          # after REM everything is literal
    while i < n:
        c = b[i]
        if c == 0x1F and i + 2 < n + 0:
            out.append(dbcs(b[i + 1], b[i + 2])); i += 3; continue
        if c == 0x22 and not raw:
            in_str = not in_str
        if c >= 0x80 and not in_str and not raw:
            t = TOKENS.get(c)
            name = t["n"] if t else "TOK_%02X" % c
            kind = t["kind"] if t else "stmt"
            prev = out[-1][-1:] if out else ""
            word = name[0].isalpha()
            if word and prev and (prev.isalnum() or prev in ')"$%'):
                out.append(" ")
            out.append(name)
            nxt = chr(b[i + 1]) if i + 1 < n else ""
            if word and kind != "func" and nxt and (nxt.isalnum() or nxt in '"-+.' or ord(nxt) >= 0x80):
                out.append(" ")
            if kind == "rem":
                raw = True
            i += 1; continue
        out.append(chr(c) if c < 0x80 else "{%02X}" % c)
        i += 1
    return "".join(out)


def detok(data):
    return [(ln, detok_line(b)) for ln, b in walk(data)]


def convert(path, out):
    text = "\n".join("%d %s" % (ln, s) for ln, s in detok(open(path, "rb").read())) + "\n"
    with io.open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return text


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("src"); ap.add_argument("dst", nargs="?")
    ap.add_argument("-o", "--out"); ap.add_argument("--all", action="store_true")
    a = ap.parse_args()
    if a.all:
        os.makedirs(a.dst, exist_ok=True)
        for f in sorted(os.listdir(a.src)):
            if f.lower().endswith(".bas"):
                convert(os.path.join(a.src, f), os.path.join(a.dst, os.path.splitext(f)[0] + ".txt"))
                print("ok", f)
    else:
        t = convert(a.src, a.out or os.path.splitext(a.src)[0] + ".txt")
