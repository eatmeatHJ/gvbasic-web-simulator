"""Measure the notes in a recording of PLAYT1 / PLAYT2 played on the official simulator.

    python analyze_play.py recording.wav            # table of every tone: start, length, pitch, note name, level, silence before it
    python analyze_play.py recording.wav --csv out.csv
    python analyze_play.py --selftest               # checks the analysis on a synthetic recording

The recording must be a 16-bit PCM WAV (Audacity: File > Export > Export as WAV). Pure Python, no extra packages.
A tone is a run of waveform periods whose pitch stays within 4 %; a new tone starts when the pitch jumps or the sound stops,
so two equal notes played back to back are reported as one tone. Lengths are good to about half a period of the tone (7 ms at 65 Hz, 1 ms at 500 Hz). Pitch comes from the time between rising zero crossings,
so it works for square waves (what the simulator plays) and for clean sine waves.
"""
import array, math, random, struct, sys, wave

NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']


def read_wav(path):
    w = wave.open(path, 'rb')
    ch, width, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
    if width != 2:
        sys.exit('need a 16-bit PCM WAV (got %d-bit); export it again from Audacity as "WAV (Microsoft) signed 16-bit PCM"' % (width * 8))
    raw = w.readframes(n)
    w.close()
    data = array.array('h')
    data.frombytes(raw)
    if sys.byteorder == 'big':
        data.byteswap()
    if ch == 1:
        mono = data
    else:  # average the channels
        mono = array.array('h', [0]) * (len(data) // ch)
        for i in range(len(mono)):
            s = 0
            for c in range(ch):
                s += data[i * ch + c]
            mono[i] = s // ch
    return mono, sr


def note_name(freq):
    if freq <= 0:
        return '-'
    n = 69 + 12 * math.log2(freq / 440.0)
    k = int(round(n))
    cents = int(round((n - k) * 100))
    return '%s%d %+dc' % (NAMES[k % 12], k // 12 - 1, cents)


def analyze(mono, sr):
    n = len(mono)
    # amplitude envelope per 10 ms block (max of |x| after removing that block's mean)
    blk = max(1, int(sr * 0.01))
    nb = n // blk + 1
    env = [0.0] * nb
    mean = [0.0] * nb
    for b in range(nb):
        seg = mono[b * blk:(b + 1) * blk]
        if not seg:
            continue
        m = sum(seg) / len(seg)
        mean[b] = m
        env[b] = max(max(seg) - m, m - min(seg))
    ordered = sorted(env)
    noise = ordered[int(len(ordered) * 0.20)]
    peak = ordered[int(len(ordered) * 0.98)]
    gate = max(4 * noise, 0.03 * peak, 30.0)
    # rising zero crossings with hysteresis, linear interpolation; only where the envelope is above the gate
    cross = []   # (time, local amplitude)
    state = -1   # -1 below, +1 above
    prev = 0.0
    for i in range(n):
        b = i // blk
        e = env[b]
        if e < gate:
            state = -1
            prev = 0.0
            continue
        x = mono[i] - mean[b]
        h = 0.15 * e
        if state < 0:
            if x > h:
                state = 1
                # the crossing lies between the last sample below -h.. and this one: estimate from the previous sample
                px = mono[i - 1] - mean[b] if i > 0 else x
                t = (i - 1 + (0 - px) / (x - px)) / sr if x != px else i / sr
                cross.append((t, e))
        else:
            if x < -h:
                state = -1
    # group the crossings into tones
    tones = []
    cur = []
    def close():
        if len(cur) >= 5:
            ts = [c[0] for c in cur]
            periods = [ts[k + 1] - ts[k] for k in range(len(ts) - 1)]
            sp = sorted(periods)
            med = sp[len(sp) // 2]
            amp = sum(c[1] for c in cur) / len(cur)
            tones.append({'start': ts[0], 'end': ts[-1] + 0.5 * med, 'freq': 1.0 / med, 'amp': amp, 'cycles': len(cur)})   # the sound ends somewhere in the half period after the last rising edge
    for t, a in cross:
        if not cur:
            cur.append((t, a)); continue
        gap = t - cur[-1][0]
        if len(cur) >= 3:
            ts = [c[0] for c in cur[-9:]]
            periods = sorted(ts[k + 1] - ts[k] for k in range(len(ts) - 1))
            med = periods[len(periods) // 2]
        elif len(cur) == 2:
            med = cur[1][0] - cur[0][0]
        else:
            med = None
        if med is None:
            if gap < 0.03:
                cur.append((t, a)); continue
            close(); cur.clear(); cur.append((t, a)); continue
        if gap < max(0.02, 3 * med) and abs(gap - med) / med < 0.06:
            cur.append((t, a))
        else:
            close(); cur.clear(); cur.append((t, a))
    close()
    return tones, peak


def report(tones, peak, csv=None):
    lines = ['%3s %8s %8s %9s %-10s %6s %8s' % ('#', 'start s', 'length s', 'Hz', 'note', 'level', 'gap s')]
    prev_end = 0.0
    rows = []
    for i, t in enumerate(tones, 1):
        gap = t['start'] - prev_end
        length = t['end'] - t['start']
        level = 20 * math.log10(max(t['amp'], 1) / max(peak, 1))
        lines.append('%3d %8.3f %8.3f %9.1f %-10s %5.1fdB %8.3f' % (i, t['start'], length, t['freq'], note_name(t['freq']), level, gap))
        rows.append((i, t['start'], length, t['freq'], note_name(t['freq']), level, gap))
        prev_end = t['end']
    print('\n'.join(lines))
    if csv:
        with open(csv, 'w', encoding='utf-8') as f:
            f.write('index,start_s,length_s,freq_hz,note,level_db,gap_before_s\n')
            for r in rows:
                f.write('%d,%.4f,%.4f,%.2f,%s,%.1f,%.4f\n' % r)
        print('wrote', csv)


def synth(notes, sr=44100, noise=0.01, dc=0.03, seed=1):
    """notes: list of (freq or 0 for silence, seconds); a square wave like the simulator's, plus noise and a DC offset"""
    rnd = random.Random(seed)
    out = array.array('h')
    for f, d in notes:
        cnt = int(d * sr)
        for i in range(cnt):
            v = 0.0
            if f:
                v = 0.6 if ((i * f / sr) % 1.0) < 0.5 else -0.6
            v += dc + rnd.uniform(-noise, noise)
            out.append(int(max(-1, min(1, v)) * 32000))
    return out


def selftest():
    sr = 44100
    plan = [(0, 0.3), (65.4, 0.2), (0, 0.05), (262, 0.4), (392, 0.025), (262, 0.05), (440, 1.0), (0, 0.5), (2000, 0.12), (0, 0.3), (523, 0.1), (659, 0.1)]
    mono = synth(plan, sr)
    tones, peak = analyze(mono, sr)
    expected = [(65.4, 0.2), (262, 0.4), (392, 0.025), (262, 0.05), (440, 1.0), (2000, 0.12), (523, 0.1), (659, 0.1)]
    report(tones, peak)
    bad = 0
    if len(tones) != len(expected):
        print('FAIL: expected %d tones, found %d' % (len(expected), len(tones))); bad += 1
    for t, (f, d) in zip(tones, expected):
        length = t['end'] - t['start']
        if abs(t['freq'] - f) / f > 0.02 or abs(length - d) > max(0.012, 0.05 * d):
            print('FAIL: expected %.1f Hz %.3f s, got %.1f Hz %.3f s' % (f, d, t['freq'], length)); bad += 1
    print('selftest', 'FAILED' if bad else 'passed')
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    args = sys.argv[1:]
    if '--selftest' in args:
        selftest()
    if not args:
        sys.exit(__doc__)
    csv = None
    if '--csv' in args:
        k = args.index('--csv'); csv = args[k + 1]; del args[k:k + 2]
    mono, sr = read_wav(args[0])
    print('%s: %.1f s, %d Hz' % (args[0], len(mono) / sr, sr))
    tones, peak = analyze(mono, sr)
    report(tones, peak, csv)
