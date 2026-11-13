import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { COLORS, FONT } from "../brand";

const EASE = Easing.bezier(0.16, 1, 0.3, 1);

/**
 * PLACEHOLDER for the team's real app demo (screen recording).
 *
 * To drop in the actual footage:
 *   1. Put the recording at `public/app-demo.mp4`
 *   2. Import { Video } from "@remotion/media" and replace the box below with:
 *        <Video src={staticFile("app-demo.mp4")} objectFit="contain"
 *               style={{ width: "100%", height: "100%" }} />
 *   3. Adjust APP_DEMO_DURATION in DemoVideo.tsx to match the clip length.
 */
export const AppDemoPlaceholder: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const appear = interpolate(frame, [0, 0.8 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const pulse = 1 + 0.06 * Math.sin((frame / fps) * Math.PI * 2 * 0.8);
  const dashShift = -(frame * 1.2);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.green,
        fontFamily: FONT,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      {/* eyebrow */}
      <div
        style={{
          position: "absolute",
          top: 90,
          fontSize: 34,
          fontWeight: 800,
          letterSpacing: 6,
          color: COLORS.coral,
          opacity: appear,
        }}
      >
        SEE IT LIVE
      </div>

      {/* dashed drop-zone box (16:9) */}
      <div
        style={{
          width: 1280,
          height: 620,
          borderRadius: 32,
          backgroundColor: "rgba(252,247,237,0.06)",
          opacity: appear,
          scale: interpolate(appear, [0, 1], [0.94, 1], {
            output: "perceptual-scale",
          }),
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 26,
          position: "relative",
        }}
      >
        {/* animated dashed border via SVG so the dashes march */}
        <svg
          width="1280"
          height="620"
          style={{ position: "absolute", inset: 0 }}
        >
          <rect
            x="4"
            y="4"
            width="1272"
            height="612"
            rx="30"
            fill="none"
            stroke={COLORS.coralSoft}
            strokeWidth="4"
            strokeDasharray="22 18"
            strokeDashoffset={dashShift}
          />
        </svg>

        {/* play glyph */}
        <div
          style={{
            width: 150,
            height: 150,
            borderRadius: "50%",
            backgroundColor: COLORS.coral,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            scale: pulse,
            boxShadow: "0 12px 0 rgba(0,0,0,0.18)",
          }}
        >
          <div
            style={{
              width: 0,
              height: 0,
              borderTop: "34px solid transparent",
              borderBottom: "34px solid transparent",
              borderLeft: `56px solid ${COLORS.cream}`,
              marginLeft: 14,
            }}
          />
        </div>

        <div style={{ fontSize: 72, fontWeight: 800, color: COLORS.cream }}>
          YOUR APP DEMO HERE
        </div>
        <div
          style={{
            fontSize: 38,
            fontWeight: 700,
            color: COLORS.mint,
            textAlign: "center",
          }}
        >
          Drop the screen recording at public/app-demo.mp4
        </div>
      </div>
    </AbsoluteFill>
  );
};
