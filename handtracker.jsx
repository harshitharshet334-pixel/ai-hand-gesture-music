import { useEffect, useRef, useState, useCallback } from "react";
import { HandLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

/**
 * HandTracker
 * --------------------------------------------------------------
 * A standalone camera + hand-tracking component. Drop it in on its
 * own to see live tracking, or pass `onHandsUpdate` to feed the
 * per-frame gesture data into something else (e.g. your Sargam
 * note logic) without touching this file.
 *
 * npm install @mediapipe/tasks-vision
 *
 * onHandsUpdate receives an array, one entry per detected hand:
 *   {
 *     handedness: "Left" | "Right",
 *     landmarks: [{x,y,z}, ...21 points],
 *     fingers: { thumb: bool, index: bool, middle: bool, ring: bool, pinky: bool }
 *   }
 * --------------------------------------------------------------
 */

const FINGERS = [
  { name: "thumb", tip: 4, pip: 3 },
  { name: "index", tip: 8, pip: 6 },
  { name: "middle", tip: 12, pip: 10 },
  { name: "ring", tip: 16, pip: 14 },
  { name: "pinky", tip: 20, pip: 18 },
];

const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [0, 9], [9, 10], [10, 11], [11, 12],
  [0, 13], [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
  [5, 9], [9, 13], [13, 17],
];

const FINGER_HUE = { thumb: 165, index: 330, middle: 45, ring: 210, pinky: 280 };

function isFingerOpen(landmarks, tipIdx, pipIdx) {
  const wrist = landmarks[0];
  const tip = landmarks[tipIdx];
  const pip = landmarks[pipIdx];
  const dTip = Math.hypot(tip.x - wrist.x, tip.y - wrist.y);
  const dPip = Math.hypot(pip.x - wrist.x, pip.y - wrist.y);
  return dTip > dPip * 1.15;
}

// Flip if your real right hand shows up labeled "Left" on screen.
const SWAP_HANDEDNESS = true;

export default function HandTracker({ onHandsUpdate, mirrored = true }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const landmarkerRef = useRef(null);
  const rafRef = useRef(null);
  const lastVideoTimeRef = useRef(-1);
  const trailsRef = useRef(new Map()); // fingertip trail points, per hand-finger key

  const [status, setStatus] = useState("loading"); // loading | ready | denied | error
  const [handCount, setHandCount] = useState(0);

  const emit = useCallback(
    (hands) => {
      if (onHandsUpdate) onHandsUpdate(hands);
    },
    [onHandsUpdate]
  );

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
        landmarkerRef.current = landmarker;

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
        rafRef.current = requestAnimationFrame(loop);
      } catch (err) {
        console.error(err);
        setStatus(err?.name === "NotAllowedError" ? "denied" : "error");
      }
    }

    function loop() {
      const video = videoRef.current;
      const landmarker = landmarkerRef.current;
      const canvas = canvasRef.current;
      if (video && landmarker && canvas && video.currentTime !== lastVideoTimeRef.current && video.readyState >= 2) {
        lastVideoTimeRef.current = video.currentTime;
        const results = landmarker.detectForVideo(video, performance.now());
        render(results, canvas);
      }
      rafRef.current = requestAnimationFrame(loop);
    }

    setup();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      stream?.getTracks().forEach((t) => t.stop());
      landmarkerRef.current?.close?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function render(results, canvas) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const hands = results.landmarks || [];
    const handednessRaw = results.handedness || [];
    setHandCount(hands.length);

    const payload = [];
    const seenKeys = new Set();

    hands.forEach((landmarks, i) => {
      let label = handednessRaw[i]?.[0]?.categoryName || "Right";
      if (SWAP_HANDEDNESS) label = label === "Left" ? "Right" : "Left";
      const baseHue = label === "Right" ? 165 : 280;

      // depth range, used for a pseudo-3D pulse
      const zs = landmarks.map((p) => p.z);
      const zMin = Math.min(...zs), zMax = Math.max(...zs);
      const zRange = Math.max(zMax - zMin, 0.001);

      // pulsing palm ring (reacts to how open the hand is)
      const openCount = FINGERS.filter((f) => isFingerOpen(landmarks, f.tip, f.pip)).length;
      const palm = landmarks[9];
      const px = palm.x * w, py = palm.y * h;
      const ringRadius = 26 + openCount * 9;
      ctx.beginPath();
      ctx.strokeStyle = `hsla(${baseHue}, 70%, 65%, ${0.25 + openCount * 0.1})`;
      ctx.lineWidth = 2;
      ctx.arc(px, py, ringRadius, 0, Math.PI * 2);
      ctx.stroke();

      // skeleton
      ctx.lineWidth = 2;
      BONES.forEach(([a, b]) => {
        const pa = landmarks[a], pb = landmarks[b];
        ctx.strokeStyle = `hsla(${baseHue}, 80%, 70%, 0.35)`;
        ctx.beginPath();
        ctx.moveTo(pa.x * w, pa.y * h);
        ctx.lineTo(pb.x * w, pb.y * h);
        ctx.stroke();
      });

      // joints, depth-scaled
      landmarks.forEach((p) => {
        const depthT = (p.z - zMin) / zRange;
        const r = 5 - depthT * 3;
        ctx.beginPath();
        ctx.fillStyle = `hsla(${baseHue}, 80%, 75%, ${1 - depthT * 0.6})`;
        ctx.shadowColor = `hsla(${baseHue}, 90%, 70%, 0.9)`;
        ctx.shadowBlur = 8 - depthT * 6;
        ctx.arc(p.x * w, p.y * h, Math.max(r, 1.2), 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.shadowBlur = 0;

      // per-finger state + fingertip comet trail for open fingers
      const fingerState = {};
      FINGERS.forEach(({ name, tip, pip }) => {
        const open = isFingerOpen(landmarks, tip, pip);
        fingerState[name] = open;
        const key = `${label}-${name}`;
        seenKeys.add(key);

        const tipPt = landmarks[tip];
        const tx = tipPt.x * w, ty = tipPt.y * h;
        const hue = FINGER_HUE[name];

        if (open) {
          const trail = trailsRef.current.get(key) || [];
          trail.push({ x: tx, y: ty });
          if (trail.length > 14) trail.shift();
          trailsRef.current.set(key, trail);

          trail.forEach((pt, idx) => {
            const t = idx / trail.length;
            ctx.beginPath();
            ctx.fillStyle = `hsla(${hue}, 90%, 70%, ${t * 0.5})`;
            ctx.arc(pt.x, pt.y, 2 + t * 4, 0, Math.PI * 2);
            ctx.fill();
          });

          ctx.beginPath();
          ctx.fillStyle = `hsl(${hue}, 90%, 70%)`;
          ctx.shadowColor = `hsl(${hue}, 90%, 70%)`;
          ctx.shadowBlur = 16;
          ctx.arc(tx, ty, 7, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
        } else {
          trailsRef.current.delete(key);
        }
      });

      payload.push({ handedness: label, landmarks, fingers: fingerState });
    });

    // drop trails for fingers no longer tracked at all
    Array.from(trailsRef.current.keys()).forEach((key) => {
      if (!seenKeys.has(key)) trailsRef.current.delete(key);
    });

    emit(payload);
  }

  return (
    <div className="ht-wrap">
      <div className="ht-stage">
        <video
          ref={videoRef}
          className="ht-video"
          playsInline
          muted
          style={{ transform: mirrored ? "scaleX(-1)" : "none" }}
        />
        <canvas
          ref={canvasRef}
          width={1280}
          height={720}
          className="ht-canvas"
          style={{ transform: mirrored ? "scaleX(-1)" : "none" }}
        />

        {status !== "ready" && (
          <div className="ht-overlay">
            <p className="ht-msg">
              {status === "loading" && "Booting hand tracker…"}
              {status === "denied" && "Camera access denied — enable it to continue."}
              {status === "error" && "Couldn't start the camera or model."}
            </p>
          </div>
        )}

        <div className="ht-badge">
          <span className={`ht-dot ht-dot--${status}`} />
          {status === "ready" ? `${handCount} hand${handCount === 1 ? "" : "s"} tracked` : status}
        </div>
      </div>

      <style>{`
        .ht-wrap { display: flex; flex-direction: column; align-items: center; gap: 10px; font-family: 'Courier New', monospace; }
        .ht-stage {
          position: relative;
          width: min(680px, 92vw);
          aspect-ratio: 16 / 9;
          background: #0a0d0c;
          border-radius: 6px;
          overflow: hidden;
          box-shadow: 0 0 0 1px rgba(160,160,255,0.15), 0 0 50px -12px rgba(160,120,255,0.35);
        }
        .ht-video, .ht-canvas { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
        .ht-video { filter: brightness(0.88); }
        .ht-canvas { pointer-events: none; }

        .ht-overlay {
          position: absolute; inset: 0;
          display: flex; align-items: center; justify-content: center;
          padding: 24px; background: rgba(10,13,12,0.85); text-align: center;
        }
        .ht-msg { font-size: 13px; color: #a7b3c9; margin: 0; }

        .ht-badge {
          position: absolute; top: 10px; left: 10px;
          display: flex; align-items: center; gap: 6px;
          font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase;
          color: #cfd6ea; background: rgba(10,13,12,0.55);
          padding: 4px 10px; border-radius: 999px;
        }
        .ht-dot { width: 6px; height: 6px; border-radius: 50%; background: #555; }
        .ht-dot--ready { background: #8fb7ff; box-shadow: 0 0 6px 2px rgba(143,183,255,0.6); }
        .ht-dot--loading { background: #d9a441; }
        .ht-dot--denied, .ht-dot--error { background: #e05d5d; }
      `}</style>
    </div>
  );
}