import("stdfaust.lib");

declare name "Continuator Custom Starter";
declare options "[midi:on][nvoices:24]";

freq = hslider("freq[hidden:1]", 440.0, 20.0, 20000.0, 0.01);
gain = hslider("gain[hidden:1]", 0.3, 0.0, 1.0, 0.001);
gate = button("gate[hidden:1]");

tone =
  hslider("Custom Starter/[0]tone[style:knob]", 0.62, 0.0, 1.0, 0.01)
  : si.smoo;
release =
  hslider(
    "Custom Starter/[1]release[unit:s][style:knob]",
    0.90,
    0.08,
    4.0,
    0.01
  )
  : si.smoo;
detune =
  hslider("Custom Starter/[2]detune[style:knob]", 0.16, 0.0, 1.0, 0.01)
  : si.smoo;
air =
  hslider("Custom Starter/[3]air[style:knob]", 0.22, 0.0, 1.0, 0.01)
  : si.smoo;

env = en.adsr(0.004, 0.12, 0.0, release, gate);
velocity = max(0.04, pow(gain, 0.74));
cutoff = 700.0 + tone * 7600.0;

body =
  os.sawtooth(freq) * 0.12 +
  os.osc(freq * 2.0) * (0.03 + tone * 0.06) +
  os.osc(freq * (1.0 + detune * 0.02)) * (0.02 + detune * 0.08) +
  no.noise * (0.001 + air * 0.012);

voice = ((body : fi.lowpass(3, cutoff)) * env) * velocity;

process = voice, voice;
