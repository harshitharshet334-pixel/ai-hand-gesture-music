import { useEffect, useRef, useState } from "react";
import * as Tone from "tone";
import HandTracker from "./handtracker";

// ---------- note mapping ----------
const RIGHT_NOTE_MAP = { thumb: "C4", index: "D4", middle: "E4", ring: "F4", pinky: "G4" };
const LEFT_NOTE_MAP  = { thumb: "C3", index: "D3", middle: "E3", ring: "A3", pinky: "B3" };
const RIGHT_DRUM_MAP = { thumb: "kick", index: "snare", middle: "hihat", ring: "tom", pinky: "crash" };
const LEFT_DRUM_MAP  = { thumb: "kick", index: "snare", middle: "hihat", ring: "tom", pinky: "crash" };

const INSTRUMENTS     = ["guitar", "drums", "piano", "violin"];
const INSTRUMENT_ICON = { guitar: "🎸", drums: "🥁", piano: "🎹", violin: "🎻" };
const SUSTAINED       = new Set(["violin"]);

export default function InstrumentPlayer() {
  const [instrument, setInstrument] = useState("guitar");
  const [audioReady, setAudioReady]  = useState(false);
  const [activeNotes, setActiveNotes] = useState([]);

  // ---- refs so callbacks never go stale ----
  const audioReadyRef  = useRef(false);
  const instrumentRef  = useRef("guitar");
  const prevKeysRef    = useRef(new Set());
  const synthsRef      = useRef({});
  const drumsRef       = useRef(null);
  const reverbRef      = useRef(null);

  instrumentRef.current = instrument;

  // ---------- build audio graph once ----------
  useEffect(() => {
    const reverb = new Tone.Reverb({ roomSize: 0.7, wet: 0.3 }).toDestination();
    const delay  = new Tone.FeedbackDelay("8n", 0.2).connect(reverb);
    reverbRef.current = reverb;

    const violinFilter = new Tone.Filter(900, "lowpass");

    synthsRef.current = {
      piano: new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: "triangle" },
        envelope:   { attack: 0.02, decay: 1.2, sustain: 0.05, release: 1.0 },
      }).connect(reverb),

      guitar: new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: "sine" },
        envelope:   { attack: 0.005, decay: 0.8, sustain: 0.0, release: 0.6 },
      }).connect(delay),

      violin: new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: "sawtooth" },
        envelope:   { attack: 0.25, decay: 0.4, sustain: 0.85, release: 1.2 },
      }).chain(violinFilter, reverb),
    };

    drumsRef.current = {
      kick:  new Tone.MembraneSynth().connect(reverb),
      snare: new Tone.NoiseSynth({
        noise:    { type: "pink" },
        envelope: { attack: 0.001, decay: 0.12, sustain: 0 },
      }).connect(reverb),
      hihat: new Tone.MetalSynth({
        envelope:    { attack: 0.001, decay: 0.05, release: 0.01 },
        harmonicity: 5.1, resonance: 3000,
      }).connect(reverb),
      tom:   new Tone.MembraneSynth({ pitchDecay: 0.02, octaves: 3 }).connect(reverb),
      crash: new Tone.MetalSynth({
        envelope:    { attack: 0.001, decay: 0.5, release: 0.1 },
        harmonicity: 4.0, resonance: 2500,
      }).connect(reverb),
    };

    return () => {
      Object.values(synthsRef.current).forEach((s) => s.dispose());
      Object.values(drumsRef.current  || {}).forEach((d) => d.dispose());
      violinFilter.dispose();
      delay.dispose();
      reverb.dispose();
    };
  }, []);

  // ---------- audio enable ----------
  async function enableAudio() {
    await Tone.start();
    audioReadyRef.current = true;
    setAudioReady(true);

    // play a tiny test note so the user knows audio works
    const test = new Tone.Synth({
      oscillator: { type: "triangle" },
      envelope:   { attack: 0.05, decay: 0.4, sustain: 0, release: 0.3 },
    }).toDestination();
    test.triggerAttackRelease("C4", "8n");
    setTimeout(() => test.dispose(), 800);
  }

  // ---------- drum hits ----------
  function hitDrum(name) {
    const kit = drumsRef.current;
    if (!kit) return;
    const now = Tone.now();
    if (name === "kick")  kit.kick.triggerAttackRelease("C1", "8n",  now);
    if (name === "snare") kit.snare.triggerAttackRelease("8n",        now);
    if (name === "hihat") kit.hihat.triggerAttackRelease("C5", "16n", now);
    if (name === "tom")   kit.tom.triggerAttackRelease("G2",  "8n",  now);
    if (name === "crash") kit.crash.triggerAttackRelease("C5", "1n",  now);
  }

  // ---------- hand data from HandTracker ----------
  function handleHands(hands) {
    // use ref so this never reads a stale audioReady
    if (!audioReadyRef.current) return;

    const inst     = instrumentRef.current;
    const openKeys = new Set();
    const readout  = [];

    hands.forEach(({ handedness, fingers }) => {
      const noteMap = handedness === "Right" ? RIGHT_NOTE_MAP : LEFT_NOTE_MAP;
      const drumMap = handedness === "Right" ? RIGHT_DRUM_MAP : LEFT_DRUM_MAP;

      Object.entries(fingers).forEach(([finger, isOpen]) => {
        if (!isOpen) return;
        const key        = `${handedness}-${finger}`;
        const justOpened = !prevKeysRef.current.has(key);
        openKeys.add(key);

        if (inst === "drums") {
          readout.push(`${handedness} ${finger} · ${drumMap[finger]}`);
          if (justOpened) hitDrum(drumMap[finger]);
          return;
        }

        const note  = noteMap[finger];
        const synth = synthsRef.current[inst];
        readout.push(`${handedness} ${finger} · ${note}`);

        if (!synth) return;
        if (SUSTAINED.has(inst)) {
          if (justOpened) synth.triggerAttack(note);
        } else if (justOpened) {
          synth.triggerAttackRelease(note, "8n");
        }
      });
    });

    // stop sustained notes when fingers close
    if (SUSTAINED.has(inst)) {
      const synth = synthsRef.current[inst];
      prevKeysRef.current.forEach((key) => {
        if (!openKeys.has(key)) {
          const [h, f] = key.split("-");
          const nm     = h === "Right" ? RIGHT_NOTE_MAP : LEFT_NOTE_MAP;
          synth?.triggerRelease(nm[f]);
        }
      });
    }

    prevKeysRef.current = openKeys;
    setActiveNotes(readout);
  }

  const currentMap = instrument === "drums" ? RIGHT_DRUM_MAP : RIGHT_NOTE_MAP;

  return (
    <div className="ip-wrap">
      <div className="ip-stage-wrap">
        {/* HandTracker lives HERE — it calls handleHands each frame */}
        <HandTracker onHandsUpdate={handleHands} />

        <div className="ip-instrument-bar">
          {INSTRUMENTS.map((name) => (
            <button
              key={name}
              className={`ip-inst-btn ${instrument === name ? "ip-inst-btn--active" : ""}`}
              onClick={() => setInstrument(name)}
            >
              <span className="ip-inst-icon">{INSTRUMENT_ICON[name]}</span>
              <span>{name}</span>
            </button>
          ))}
        </div>

        {!audioReady && (
          <button className="ip-audio-btn" onClick={enableAudio}>
            ▶ Tap to enable sound
          </button>
        )}
      </div>

      <div className="ip-readout">
        <span className="ip-readout-label">{instrument} ·</span>
        <span className="ip-readout-notes">
          {activeNotes.length ? activeNotes.join("   ") : "—"}
        </span>
      </div>

      <div className="ip-legend">
        <h4>{instrument === "drums" ? "Drum mapping" : "Note mapping"} (right hand)</h4>
        <div className="ip-legend-row">
          {Object.entries(currentMap).map(([finger, val]) => (
            <span key={finger} className="ip-legend-chip">{finger} → {val}</span>
          ))}
        </div>
      </div>

      <style>{`
        .ip-wrap { display:flex; flex-direction:column; align-items:center; gap:14px; font-family:'Courier New',monospace; color:#d7e6e1; }
        .ip-stage-wrap { position:relative; width:min(680px,92vw); }

        .ip-instrument-bar {
          position:absolute; top:10px; right:10px;
          display:flex; flex-direction:column; gap:6px; z-index:5;
        }
        .ip-inst-btn {
          display:flex; align-items:center; gap:6px;
          background:rgba(10,13,12,0.65);
          border:1px solid rgba(93,227,191,0.3);
          color:#cfe6df; font-family:inherit; font-size:11px;
          text-transform:uppercase; letter-spacing:0.05em;
          padding:6px 10px; border-radius:999px; cursor:pointer;
          transition:all 0.15s ease;
        }
        .ip-inst-btn:hover { border-color:rgba(93,227,191,0.7); }
        .ip-inst-btn--active {
          background:rgba(93,227,191,0.18); border-color:#5de3bf;
          color:#5de3bf; box-shadow:0 0 10px rgba(93,227,191,0.35);
        }
        .ip-inst-icon { font-size:14px; }

        .ip-audio-btn {
          position:absolute; bottom:14px; left:50%;
          transform:translateX(-50%);
          background:rgba(93,227,191,0.15);
          border:1px solid rgba(93,227,191,0.6);
          color:#5de3bf; padding:8px 16px; border-radius:999px;
          font-family:inherit; font-size:12px; cursor:pointer; z-index:5;
        }

        .ip-readout { font-size:13px; display:flex; gap:8px; }
        .ip-readout-label { color:#7c8f89; text-transform:uppercase; font-size:11px; letter-spacing:0.08em; }
        .ip-readout-notes { color:#5de3bf; }

        .ip-legend { text-align:center; }
        .ip-legend h4 { margin:0 0 6px; font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:#7c8f89; }
        .ip-legend-row { display:flex; gap:8px; flex-wrap:wrap; justify-content:center; }
        .ip-legend-chip {
          font-size:11px; color:#b7c9c4;
          border:1px solid rgba(93,227,191,0.25);
          padding:3px 8px; border-radius:999px;
        }
      `}</style>
    </div>
  );
}