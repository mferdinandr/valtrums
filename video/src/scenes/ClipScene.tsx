import { Video } from "@remotion/media";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { COLORS, FONT } from "../brand";

const EASE = Easing.bezier(0.16, 1, 0.3, 1);

type Props = {
  src: string; // file in public/
  step: string; // e.g. "01"
  caption: string;
};

export const ClipScene: React.FC<Props> = ({ src, step, caption }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const inOpacity = interpolate(frame, [4, 0.7 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const inShift = interpolate(frame, [4, 0.8 * fps], [50, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  // keep caption on screen, fade near the very end
  const outOpacity = interpolate(
    frame,
    [durationInFrames - 12, durationInFrames - 2],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.cream }}>
      <Video
        src={staticFile(src)}
        objectFit="cover"
        style={{ width: "100%", height: "100%" }}
      />

      <AbsoluteFill
        style={{
          fontFamily: FONT,
          justifyContent: "flex-end",
          alignItems: "flex-start",
          padding: "0 0 70px 90px",
          opacity: Math.min(inOpacity, outOpacity),
          translate: `0px ${inShift}px`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 20,
            backgroundColor: "rgba(252, 247, 237, 0.92)",
            border: `3px solid ${COLORS.coralSoft}`,
            borderRadius: 26,
            padding: "22px 34px",
            boxShadow: "0 10px 0 rgba(30,77,63,0.10)",
            maxWidth: 1180,
          }}
        >
          <div
            style={{
              flexShrink: 0,
              width: 70,
              height: 70,
              borderRadius: 20,
              backgroundColor: COLORS.green,
              color: COLORS.cream,
              fontSize: 34,
              fontWeight: 800,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {step}
          </div>
          <div
            style={{
              fontSize: 54,
              fontWeight: 800,
              color: COLORS.green,
              lineHeight: 1.1,
            }}
          >
            {caption}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
