import { useEffect, useRef, useState, useCallback } from "react";
import { HandLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

/**
 * GestureMusicController
 * --------------------------------------------------------------
 * Tracks both hands via MediaPipe HandLandmarker and plays a
 * Sargam (Sa Re Ga Ma Pa ...) note per extended finger.
 *
 * npm install @mediapipe/tasks-vision
 *
 * MAPPING (edit the two objects below to change it):
 *   Right hand: thumb=Sa, index=Re, middle=Ga, ring=Ma, pinky=Pa
 *   Left hand:  thumb=Sa, index=Re, middle=Ga, ring=Dha, pinky=Ni
 *               (left hand plays one octave lower so it doesn't
 *               collide with the right hand's Sa/Re/Ga)
 *
 * Opening more than one finger at once plays those notes together —
 * this isn't special-cased, it's just what independent per-finger
 * tracking gives you for free.
 * --------------------------------------------------------------
 */

// ---------- music theory ----------
const ROOT_FREQ = 261.63; // Sa = middle C by default
const RATIOS = { Sa: 1, Re: 9 / 8, Ga: 5 / 4, Ma: 4 / 3, Pa: 3 / 2, Dha: 5 / 3, Ni: 15 / 8,sa:2 / 1 };
const NOTE_COLOR = {
  Sa: "#5de3bf", Re: "#e35d9e", Ga: "#e3c15d",
  Ma: "#5d8ee3", Pa: "#c15de3", Dha: "#e37d5d", Ni: "#8de35d", sa: "#5de3bf"
};

function noteFreq(note, octaveShift = 0) {
  return ROOT_FREQ * RATIOS[note] * Math.pow(2, octaveShift);
}

// ---------- gesture -> note mapping ----------
const RIGHT_MAP = { thumb: "Sa", index: "Re", middle: "Ga", ring: "Ma", pinky: "Pa" };
const LEFT_MAP = { thumb: "dha", index: "ni", middle: "sa" };
const LEFT_OCTAVE_SHIFT = -1; // left hand plays an octave lower

// Flip this if your real right hand gets detected as "Left" on screen.
// (MediaPipe assumes a mirrored selfie frame; getUserMedia gives an
// un-mirrored frame, so labels usually need swapping — true by default.)
const SWAP_HANDEDNESS = true;

const FINGERS = [
  { name: "thumb", tip: 4, pip: 3 },
  { name: "index", tip: 8, pip: 6 },
  { name: "middle", tip: 12, pip: 10 },
  { name: "ring", tip: 16, pip: 14 },
  { name: "pinky", tip: 20, pip: 18 },
];

function isFingerOpen(landmarks, tipIdx, pipIdx) {
  const wrist = landmarks[0];
  const tip = landmarks[tipIdx];
  const pip = landmarks[pipIdx];
  const dTip = Math.hypot(tip.x - wrist.x, tip.y - wrist.y);
  const dPip = Math.hypot(pip.x - wrist.x, pip.y - wrist.y);
  return dTip > dPip * 1.15;
}

export default function GestureMusicController() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const containerRef = useRef(null);

  const handLandmarkerRef = useRef(null);
  const rafRef = useRef(null);
  const lastVideoTimeRef = useRef(-1);

  const audioCtxRef = useRef(null);
  const activeOscRef = useRef(new Map()); // noteKey -> {osc, gain}

  const [status, setStatus] = useState("loading"); // loading | ready | denied | error
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [activeNotes, setActiveNotes] = useState([]); // for the readout
  const [bursts, setBursts] = useState([]); // gasp/pop animations

  // ---------- audio engine ----------
  const ensureAudioCtx = useCallback(() => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioCtxRef.current;
  }, []);

  const noteOn = useCallback((key, freq) => {
    const ctx = ensureAudioCtx();
    if (activeOscRef.current.has(key)) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    osc.type = "triangle";
    osc.frequency.value = freq;
    filter.type = "lowpass";
    filter.frequency.value = 2200;

    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 0.05);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    osc.start();

    activeOscRef.current.set(key, { osc, gain });
  }, [ensureAudioCtx]);

  const noteOff = useCallback((key) => {
    const ctx = audioCtxRef.current;
    const entry = activeOscRef.current.get(key);
    if (!ctx || !entry) return;
    const { osc, gain } = entry;
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.15);
    setTimeout(() => {
      try { osc.stop(); } catch (_) {}
    }, 200);
    activeOscRef.current.delete(key);
  }, []);

  // ---------- setup: model + camera ----------
  useEffect(() => {
    let cancelled = false;
    let stream;

    async function setup() {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
        );
        const landmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numHands: 2,
        });
        if (cancelled) return;
        handLandmarkerRef.current = landmarker;

        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 1280, height: 720, facingMode: "user" },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        videoRef.current.srcObject = stream;
        await videoRef.current.play();

        setStatus("ready");
        rafRef.current = requestAnimationFrame(detectLoop);
      } catch (err) {
        console.error(err);
        setStatus(err?.name === "NotAllowedError" ? "denied" : "error");
      }
    }

    function detectLoop() {
      const video = videoRef.current;
      const landmarker = handLandmarkerRef.current;
      const canvas = canvasRef.current;
      if (!video || !landmarker || !canvas) {
        rafRef.current = requestAnimationFrame(detectLoop);
        return;
      }

      if (video.currentTime !== lastVideoTimeRef.current && video.readyState >= 2) {
        lastVideoTimeRef.current = video.currentTime;
        const results = landmarker.detectForVideo(video, performance.now());
        processResults(results, canvas);
      }
      rafRef.current = requestAnimationFrame(detectLoop);
    }

    setup();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      stream?.getTracks().forEach((t) => t.stop());
      handLandmarkerRef.current?.close?.();
      activeOscRef.current.forEach((_, key) => noteOff(key));
      audioCtxRef.current?.close?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- per-frame processing ----------
  const prevActiveKeysRef = useRef(new Set());

  function processResults(results, canvas) {
    const ctx2d = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    ctx2d.clearRect(0, 0, w, h);

    const hands = results.landmarks || [];
    const handedness = results.handedness || [];
    const currentKeys = new Set();
    const newBursts = [];

    hands.forEach((landmarks, i) => {
      let label = handedness[i]?.[0]?.categoryName || "Right";
      if (SWAP_HANDEDNESS) label = label === "Left" ? "Right" : "Left";
      const map = label === "Right" ? RIGHT_MAP : LEFT_MAP;
      const octaveShift = label === "Right" ? 0 : LEFT_OCTAVE_SHIFT;

      // depth range for this hand, used to fake a "3D" glow/size effect
      const zs = landmarks.map((p) => p.z);
      const zMin = Math.min(...zs), zMax = Math.max(...zs);
      const zRange = Math.max(zMax - zMin, 0.001);

      // draw connections (simple skeleton)
      ctx2d.strokeStyle = "rgba(93, 227, 191, 0.35)";
      ctx2d.lineWidth = 2;
      const bones = [
        [0, 1], [1, 2], [2, 3], [3, 4],
        [0, 5], [5, 6], [6, 7], [7, 8],
        [0, 9], [9, 10], [10, 11], [11, 12],
        [0, 13], [13, 14], [14, 15], [15, 16],
        [0, 17], [17, 18], [18, 19], [19, 20],
      ];
      bones.forEach(([a, b]) => {
        const pa = landmarks[a], pb = landmarks[b];
        ctx2d.beginPath();
        ctx2d.moveTo(pa.x * w, pa.y * h);
        ctx2d.lineTo(pb.x * w, pb.y * h);
        ctx2d.stroke();
      });

      // draw landmark dots with depth-based size ("3D" feel)
      landmarks.forEach((p) => {
        const depthT = (p.z - zMin) / zRange; // 0 (near) .. 1 (far)
        const radius = 6 - depthT * 3.5;
        ctx2d.beginPath();
        ctx2d.fillStyle = `rgba(93, 227, 191, ${1 - depthT * 0.6})`;
        ctx2d.shadowColor = "rgba(93, 227, 191, 0.9)";
        ctx2d.shadowBlur = 10 - depthT * 8;
        ctx2d.arc(p.x * w, p.y * h, Math.max(radius, 1.5), 0, Math.PI * 2);
        ctx2d.fill();
      });
      ctx2d.shadowBlur = 0;

      // per-finger open/closed -> note + laser beam
      FINGERS.forEach(({ name, tip, pip }) => {
        const note = map[name];
        if (!note) return;
        const open = isFingerOpen(landmarks, tip, pip);
        const key = `${label}-${name}`;

        if (open) {
          currentKeys.add(key);
          const color = NOTE_COLOR[note];
          const tipPt = landmarks[tip];
          const pipPt = landmarks[pip];
          const tx = tipPt.x * w, ty = tipPt.y * h;
          const px = pipPt.x * w, py = pipPt.y * h;

          // laser beam: extend the pip->tip direction far past the tip
          const dx = tx - px, dy = ty - py;
          const len = Math.hypot(dx, dy) || 1;
          const ux = dx / len, uy = dy / len;
          const farX = tx + ux * 900;
          const farY = ty + uy * 900;

          const grad = ctx2d.createLinearGradient(tx, ty, farX, farY);
          grad.addColorStop(0, color);
          grad.addColorStop(1, "rgba(0,0,0,0)");

          ctx2d.beginPath();
          ctx2d.strokeStyle = grad;
          ctx2d.lineWidth = 3;
          ctx2d.shadowColor = color;
          ctx2d.shadowBlur = 14;
          ctx2d.moveTo(tx, ty);
          ctx2d.lineTo(farX, farY);
          ctx2d.stroke();
          ctx2d.shadowBlur = 0;

          // fingertip glow
          ctx2d.beginPath();
          ctx2d.fillStyle = color;
          ctx2d.shadowColor = color;
          ctx2d.shadowBlur = 16;
          ctx2d.arc(tx, ty, 7, 0, Math.PI * 2);
          ctx2d.fill();
          ctx2d.shadowBlur = 0;

          // newly opened -> trigger note + burst animation
          if (!prevActiveKeysRef.current.has(key)) {
            noteOn(key, noteFreq(note, octaveShift));
            newBursts.push({
              id: `${key}-${performance.now()}`,
              label: note,
              color,
              xPct: (1 - tipPt.x) * 100, // mirrored to match displayed video
              yPct: tipPt.y * 100,
            });
          }
        }
      });
    });

    // notes that were on last frame but not this frame -> note off
    prevActiveKeysRef.current.forEach((key) => {
      if (!currentKeys.has(key)) noteOff(key);
    });
    prevActiveKeysRef.current = currentKeys;

    setActiveNotes(
      Array.from(currentKeys).map((k) => {
        const [hand, finger] = k.split("-");
        const map = hand === "Right" ? RIGHT_MAP : LEFT_MAP;
        return `${hand} ${finger} · ${map[finger]}`;
      })
    );

    if (newBursts.length) {
      setBursts((b) => [...b, ...newBursts]);
      newBursts.forEach((burst) => {
        setTimeout(() => {
          setBursts((b) => b.filter((x) => x.id !== burst.id));
        }, 900);
      });
    }
  }

  function handleEnableAudio() {
    ensureAudioCtx().resume();
    setAudioEnabled(true);
  }

  return (
    <div className="gm-wrap" ref={containerRef}>
      <div className="gm-stage">
        <video ref={videoRef} className="gm-video" playsInline muted />
        <canvas ref={canvasRef} width={1280} height={720} className="gm-canvas" />

        {bursts.map((b) => (
          <div
            key={b.id}
            className="gm-burst"
            style={{ left: `${b.xPct}%`, top: `${b.yPct}%`, color: b.color, borderColor: b.color }}
          >
            {b.label}
          </div>
        ))}

        {status !== "ready" && (
          <div className="gm-overlay">
            <p className="gm-msg">
              {status === "loading" && "Loading hand tracking model…"}
              {status === "denied" && "Camera access denied — enable it to continue."}
              {status === "error" && "Couldn't start the camera or model."}
            </p>
          </div>
        )}

        {status === "ready" && !audioEnabled && (
          <button className="gm-audio-btn" onClick={handleEnableAudio}>
            ▶ Tap to enable sound
          </button>
        )}
      </div>

      <div className="gm-readout">
        <span className="gm-readout-label">Playing:</span>
        <span className="gm-readout-notes">
          {activeNotes.length ? activeNotes.join("   ") : "—"}
        </span>
      </div>

      <div className="gm-legend">
        <div className="gm-legend-col">
          <h4>Right hand</h4>
          {Object.entries(RIGHT_MAP).map(([finger, note]) => (
            <div key={finger} className="gm-legend-row">
              <span className="gm-legend-dot" style={{ background: NOTE_COLOR[note] }} />
              <span>{finger} → {note}</span>
            </div>
          ))}
        </div>
        <div className="gm-legend-col">
          <h4>Left hand (−1 octave)</h4>
          {Object.entries(LEFT_MAP).map(([finger, note]) => (
            <div key={finger} className="gm-legend-row">
              <span className="gm-legend-dot" style={{ background: NOTE_COLOR[note] }} />
              <span>{finger} → {note}</span>
            </div>
          ))}
        </div>
      </div>

      <style>{`
        .gm-wrap {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 16px;
          font-family: 'Courier New', monospace;
          color: #d7e6e1;
        }
        .gm-stage {
          position: relative;
          width: min(720px, 92vw);
          aspect-ratio: 16 / 9;
          background: #0b0e0d;
          border-radius: 6px;
          overflow: hidden;
          box-shadow: 0 0 0 1px rgba(93,227,191,0.25), 0 0 50px -10px rgba(93,227,191,0.3);
        }
        .gm-video, .gm-canvas {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          transform: scaleX(-1);
          object-fit: cover;
        }
        .gm-video { filter: brightness(0.9); }
        .gm-canvas { pointer-events: none; }

        .gm-burst {
          position: absolute;
          transform: translate(-50%, -50%);
          font-weight: bold;
          font-size: 22px;
          padding: 6px 12px;
          border: 2px solid;
          border-radius: 999px;
          background: rgba(11,14,13,0.6);
          pointer-events: none;
          animation: gm-pop 0.9s ease-out forwards;
        }
        @keyframes gm-pop {
          0%   { opacity: 0; scale: 0.4; }
          25%  { opacity: 1; scale: 1.25; }
          100% { opacity: 0; scale: 1.6; }
        }

        .gm-overlay {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          background: rgba(11,14,13,0.85);
          text-align: center;
        }
        .gm-msg { font-size: 13px; color: #9fb3ac; }

        .gm-audio-btn {
          position: absolute;
          bottom: 14px;
          left: 50%;
          transform: translateX(-50%);
          background: rgba(93,227,191,0.15);
          border: 1px solid rgba(93,227,191,0.6);
          color: #5de3bf;
          padding: 8px 16px;
          border-radius: 999px;
          font-family: inherit;
          font-size: 12px;
          cursor: pointer;
          letter-spacing: 0.04em;
        }
        .gm-audio-btn:hover { background: rgba(93,227,191,0.25); }

        .gm-readout {
          font-size: 13px;
          display: flex;
          gap: 8px;
        }
        .gm-readout-label { color: #7c8f89; text-transform: uppercase; font-size: 11px; letter-spacing: 0.08em; }
        .gm-readout-notes { color: #5de3bf; }

        .gm-legend {
          display: flex;
          gap: 36px;
          font-size: 12px;
        }
        .gm-legend-col h4 {
          margin: 0 0 6px;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #7c8f89;
        }
        .gm-legend-row { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; color: #b7c9c4; }
        .gm-legend-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
      `}</style>
    </div>
  );
}