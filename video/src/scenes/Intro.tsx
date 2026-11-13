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

export const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const logoScale = interpolate(frame, [0, 0.9 * fps], [0.6, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
    output: "perceptual-scale",
  });
  const logoOpacity = interpolate(frame, [0, 0.6 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const titleShift = interpolate(frame, [0.4 * fps, 1.3 * fps], [40, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const titleOpacity = interpolate(frame, [0.4 * fps, 1.1 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const tagOpacity = interpolate(frame, [0.9 * fps, 1.6 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.cream,
        backgroundImage: `radial-gradient(circle at 50% 38%, ${COLORS.creamDeep} 0%, ${COLORS.cream} 60%)`,
        fontFamily: FONT,
        justifyContent: "center",
        alignItems: "center",
        gap: 10,
      }}
    >
      <CanvasImage
        src={staticFile("valtrum-logo.png")}
        style={{
          width: 300,
          height: 300,
          opacity: logoOpacity,
          scale: logoScale,
        }}
      />
      <div
        style={{
          fontSize: 150,
          fontWeight: 800,
          letterSpacing: 10,
          color: COLORS.green,
          opacity: titleOpacity,
          translate: `0px ${titleShift}px`,
          lineHeight: 1,
        }}
      >
        VALTRUM
      </div>
      <div
        style={{
          fontSize: 50,
          fontWeight: 700,
          color: COLORS.rose,
          opacity: tagOpacity,
          maxWidth: 1300,
          textAlign: "center",
          marginTop: 6,
        }}
      >
        Token communities battle for each other's tokens
      </div>
    </AbsoluteFill>
  );
};
