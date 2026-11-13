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
 * Problem beat — frames the "why" before the VALTRUM reveal.
 * Copy is editable; keep it to two short lines so it reads in ~3s.
 */
export const ProblemStatement: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const eyebrow = interpolate(frame, [0, 0.5 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const line1Opacity = interpolate(frame, [0.3 * fps, 0.9 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const line1Shift = interpolate(frame, [0.3 * fps, 1.0 * fps], [40, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const line2Opacity = interpolate(frame, [0.75 * fps, 1.4 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const line2Shift = interpolate(frame, [0.75 * fps, 1.5 * fps], [40, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const underline = interpolate(frame, [1.3 * fps, 2.0 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.cream,
        backgroundImage: `radial-gradient(circle at 50% 42%, ${COLORS.creamDeep} 0%, ${COLORS.cream} 64%)`,
        fontFamily: FONT,
        justifyContent: "center",
        alignItems: "center",
        gap: 22,
        padding: "0 160px",
      }}
    >
      <div
        style={{
          fontSize: 32,
          fontWeight: 800,
          letterSpacing: 8,
          color: COLORS.coral,
          opacity: eyebrow,
        }}
      >
        THE PROBLEM
      </div>

      <div
        style={{
          fontSize: 84,
          fontWeight: 800,
          color: COLORS.green,
          textAlign: "center",
          lineHeight: 1.08,
          opacity: line1Opacity,
          translate: `0px ${line1Shift}px`,
          maxWidth: 1500,
        }}
      >
        Communities hype their tokens everywhere.
      </div>

      <div
        style={{
          fontSize: 84,
          fontWeight: 800,
          textAlign: "center",
          lineHeight: 1.08,
          color: COLORS.textSoft,
          opacity: line2Opacity,
          translate: `0px ${line2Shift}px`,
          maxWidth: 1500,
        }}
      >
        No arena ever settles it{" "}
        <span style={{ position: "relative", color: COLORS.rose }}>
          on-chain.
          <span
            style={{
              position: "absolute",
              left: 0,
              bottom: -10,
              height: 10,
              width: `${underline * 100}%`,
              backgroundColor: COLORS.coralSoft,
              borderRadius: 6,
            }}
          />
        </span>
      </div>
    </AbsoluteFill>
  );
};
