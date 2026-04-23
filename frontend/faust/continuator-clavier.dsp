import("stdfaust.lib");

declare name "Continuator Clavier";
declare options "[midi:on][nvoices:24]";

freq = hslider("freq[hidden:1]", 440.0, 20.0, 20000.0, 0.01);
gain = hslider("gain[hidden:1]", 0.3, 0.0, 1.0, 0.001);
gate = button("gate[hidden:1]");

brightness =
  hslider("Continuator Clavier/[0]brightness[style:knob]", 0.58, 0.0, 1.0, 0.01)
  : si.smoo;
hardness =
  hslider("Continuator Clavier/[1]hardness[style:knob]", 0.34, 0.0, 1.0, 0.01)
  : si.smoo;
damping =
  hslider("Continuator Clavier/[2]damping[style:knob]", 0.42, 0.0, 1.0, 0.01)
  : si.smoo;
release =
  hslider(
    "Continuator Clavier/[3]release[unit:s][style:knob]",
    0.95,
    0.08,
    4.0,
    0.01
  )
  : si.smoo;
body =
  hslider("Continuator Clavier/[4]body[style:knob]", 0.33, 0.0, 1.0, 0.01)
  : si.smoo;
stereo =
  hslider("Continuator Clavier/[5]stereo[style:knob]", 0.45, 0.0, 1.0, 0.01)
  : si.smoo;

strike = en.adsr(
  0.0015 + (1.0 - hardness) * 0.008,
  0.08 + damping * 0.14,
  0.0,
  0.10 + release * 0.22,
  gate
);
tail = en.adsr(
  0.002,
  0.18 + damping * 0.18,
  0.0,
  release,
  gate
);

velocity = max(0.03, pow(gain, 0.72 - hardness * 0.28));
cutoff = 900.0 + brightness * 7800.0;
overtone = 2.0 + brightness * 2.6;
pan = stereo * 0.32 * sin(freq * 0.0017);

excitation =
  os.osc(freq) * 0.17 +
  os.sawtooth(freq * overtone) * (0.012 + brightness * 0.07) +
  os.osc(freq * (3.0 + brightness * 4.0)) * (0.01 + hardness * 0.05) +
  no.noise * (0.001 + hardness * 0.016);

bodyResonance =
  os.osc(freq * 0.5) * (0.018 + body * 0.075) +
  os.osc(freq * 1.5) * (0.006 + body * 0.022);

voice = (
  ((excitation * strike) : fi.lowpass(3, cutoff)) +
  (bodyResonance * tail)
) * velocity;

left = voice * sqrt(0.5 * (1.0 - pan));
right = voice * sqrt(0.5 * (1.0 + pan));

process = left, right;
