import {
  AbsoluteFill,
  CanvasImage,
  Easing,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { COLORS, FONT } from "../brand";

const EASE = Easing.bezier(0.16, 1, 0.3, 1);

/** CTA outro links. */
const LINKS = {
  demo: "valtrums.xyz",
  repo: "github.com/mferdinandr/valtrums",
  event: "NEAR Hackathon",
};

export const CtaOutro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const appear = interpolate(frame, [0, 0.8 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const logoScale = interpolate(frame, [0, fps], [0.7, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
    output: "perceptual-scale",
  });
  const line = interpolate(frame, [0.5 * fps, 1.2 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const pills = interpolate(frame, [1.0 * fps, 1.7 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const footer = interpolate(frame, [1.5 * fps, 2.2 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.cream,
        backgroundImage: `radial-gradient(circle at 50% 40%, ${COLORS.creamDeep} 0%, ${COLORS.cream} 64%)`,
        fontFamily: FONT,
        justifyContent: "center",
        alignItems: "center",
        gap: 14,
      }}
    >
      <CanvasImage
        src={staticFile("valtrum-logo.png")}
        style={{ width: 160, height: 160, opacity: appear, scale: logoScale }}
      />
      <div
        style={{
          fontSize: 84,
          fontWeight: 800,
          letterSpacing: 6,
          color: COLORS.green,
          opacity: appear,
        }}
      >
        VALTRUM
      </div>
      <div
        style={{
          fontSize: 40,
          fontWeight: 700,
          color: COLORS.rose,
          opacity: line,
          textAlign: "center",
          maxWidth: 1300,
        }}
      >
        A permissionless token-community arena
      </div>

      {/* CTA pills */}
      <div
        style={{
          display: "flex",
          gap: 26,
          marginTop: 26,
          opacity: pills,
          translate: `0px ${interpolate(pills, [0, 1], [26, 0])}px`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            backgroundColor: COLORS.coral,
            color: COLORS.cream,
            fontSize: 34,
            fontWeight: 800,
            padding: "20px 38px",
            borderRadius: 999,
            boxShadow: "0 9px 0 rgba(30,77,63,0.16)",
          }}
        >
          <span style={{ fontSize: 24 }}>▶</span> Live demo · {LINKS.demo}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            backgroundColor: "transparent",
            color: COLORS.green,
            border: `3px solid ${COLORS.green}`,
            fontSize: 34,
            fontWeight: 800,
            padding: "17px 36px",
            borderRadius: 999,
          }}
        >
          <span style={{ fontWeight: 900 }}>{"</>"}</span> {LINKS.repo}
        </div>
      </div>

      <div
        style={{
          fontSize: 30,
          fontWeight: 700,
          color: COLORS.textSoft,
          opacity: footer,
          marginTop: 22,
        }}
      >
        Built on NEAR · adjustable rounds · {LINKS.event}
      </div>
    </AbsoluteFill>
  );
};
