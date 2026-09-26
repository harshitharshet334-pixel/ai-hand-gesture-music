import React, { useRef, useEffect, useState } from "react";

/**
 * CameraFeed
 * Minimal, aesthetic webcam viewer for hand-gesture + music detection.
 * Mirrors the video so your face/hands appear naturally (like a mirror),
 * which is what you want for gesture-based UIs.
 *
 * Usage:
 *   <CameraFeed onStream={(video) => {/* pass video ref to your gesture model *\/}} />
 */
export default function CameraFeed({ onStream }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [status, setStatus] = useState("idle"); // idle | requesting | active | error
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function startCamera() {
      setStatus("requesting");
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 1280, height: 720, facingMode: "user" },
          audio: false,
        });

        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        setStatus("active");
        if (onStream) onStream(videoRef.current);
      } catch (err) {
        setError(err.message || "Camera access denied");
        setStatus("error");
      }
    }

    startCamera();

    return () => {
      cancelled = true;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, [onStream]);

  return (
    <div style={styles.wrapper}>
      <div style={styles.frame}>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          style={styles.video}
        />

        {status !== "active" && (
          <div style={styles.overlay}>
            {status === "requesting" && (
              <p style={styles.overlayText}>Requesting camera access…</p>
            )}
            {status === "error" && (
              <p style={styles.overlayText}>
                ⚠️ {error || "Could not access camera"}
              </p>
            )}
          </div>
        )}

        {status === "active" && <div style={styles.liveDot} />}
      </div>
    </div>
  );
}

const styles = {
  wrapper: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    padding: "24px",
  },
  frame: {
    position: "relative",
    width: "100%",
    maxWidth: "640px",
    aspectRatio: "16 / 9",
    borderRadius: "20px",
    overflow: "hidden",
    background: "#0f0f10",
    boxShadow: "0 8px 30px rgba(0,0,0,0.35)",
    border: "1px solid rgba(255,255,255,0.08)",
  },
  video: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    transform: "scaleX(-1)", // mirror so face appears naturally
  },
  overlay: {
    position: "absolute",
    inset: 0,
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    background: "rgba(15,15,16,0.85)",
    backdropFilter: "blur(4px)",
  },
  overlayText: {
    color: "#e5e5e5",
    fontFamily: "system-ui, sans-serif",
    fontSize: "15px",
    padding: "0 20px",
    textAlign: "center",
  },
  liveDot: {
    position: "absolute",
    top: "14px",
    right: "16px",
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    background: "#ff4d4d",
    boxShadow: "0 0 8px #ff4d4d",
  },
};