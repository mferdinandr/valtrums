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
 * "Built on NEAR" — the technical differentiator for the hackathon.
 * Three real NEAR primitives (verified against the repo stack):
 *   - NEAR smart contracts (Rust, near-sdk)
 *   - NEAR Chain Signatures / MPC (cross-chain token custody)
 *   - NEAR AI Cloud / TEE (autonomous player agents choose plays)
 */

type Pillar = {
  tile: string;
  title: string;
  body: string;
  icon: React.ReactNode;
};

const stroke = {
  fill: "none",
  stroke: COLORS.cream,
  strokeWidth: 3.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const PILLARS: Pillar[] = [
  {
    tile: COLORS.green,
    title: "NEAR smart contracts",
    body: "Arena lifecycle, rounds & scoring run in Rust contracts.",
    icon: (
      <svg width="58" height="58" viewBox="0 0 48 48">
        <rect x="12" y="7" width="24" height="34" rx="5" {...stroke} />
        <line x1="18" y1="18" x2="30" y2="18" {...stroke} />
        <line x1="18" y1="24" x2="30" y2="24" {...stroke} />
        <line x1="18" y1="30" x2="26" y2="30" {...stroke} />
      </svg>
    ),
  },
  {
    tile: COLORS.coral,
    title: "Chain Signatures (MPC)",
    body: "NEAR MPC signs cross-chain token custody. No bridge.",
    icon: (
      <svg width="58" height="58" viewBox="0 0 48 48">
        <g transform="rotate(-40 24 24)">
          <rect x="7" y="18" width="22" height="12" rx="6" {...stroke} />
          <rect x="19" y="18" width="22" height="12" rx="6" {...stroke} />
        </g>
      </svg>
    ),
  },
  {
    tile: COLORS.rose,
    title: "NEAR AI Cloud (TEE)",
    body: "Autonomous player agents decide each play in a TEE.",
    icon: (
      <svg width="58" height="58" viewBox="0 0 48 48">
        <path
          d="M24 5 L39 11 V23 C39 33 32 39 24 42 C16 39 9 33 9 23 V11 Z"
          {...stroke}
        />
        <path d="M17 24 l5 5 l9 -12" {...stroke} />
      </svg>
    ),
  },
];

const Card: React.FC<{ pillar: Pillar; delay: number }> = ({
  pillar,
  delay,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = interpolate(frame, [delay, delay + 0.6 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });

  return (
    <div
      style={{
        width: 500,
        backgroundColor: COLORS.cream,
        border: `3px solid ${COLORS.coralSoft}`,
        borderRadius: 30,
        padding: "42px 36px",
        boxShadow: "0 12px 0 rgba(30,77,63,0.10)",
        display: "flex",
        flexDirection: "column",
        gap: 20,
        opacity: t,
        translate: `0px ${interpolate(t, [0, 1], [50, 0])}px`,
      }}
    >
      <div
        style={{
          width: 94,
          height: 94,
          borderRadius: 26,
          backgroundColor: pillar.tile,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 8px 0 rgba(30,77,63,0.14)",
        }}
      >
        {pillar.icon}
      </div>
      <div style={{ fontSize: 42, fontWeight: 800, color: COLORS.green }}>
        {pillar.title}
      </div>
      <div
        style={{
          fontSize: 30,
          fontWeight: 600,
          color: COLORS.textSoft,
          lineHeight: 1.3,
        }}
      >
        {pillar.body}
      </div>
    </div>
  );
};

export const NearTech: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const eyebrow = interpolate(frame, [0, 0.5 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const headingShift = interpolate(frame, [0.2 * fps, 0.9 * fps], [34, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.cream,
        backgroundImage: `radial-gradient(circle at 50% 30%, ${COLORS.creamDeep} 0%, ${COLORS.cream} 70%)`,
        fontFamily: FONT,
        justifyContent: "center",
        alignItems: "center",
        gap: 46,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 10,
          opacity: eyebrow,
          translate: `0px ${headingShift}px`,
        }}
      >
        <div
          style={{
            fontSize: 32,
            fontWeight: 800,
            letterSpacing: 8,
            color: COLORS.coral,
          }}
        >
          BUILT ON NEAR
        </div>
        <div
          style={{
            fontSize: 60,
            fontWeight: 800,
            color: COLORS.green,
            textAlign: "center",
          }}
        >
          Three NEAR primitives do the heavy lifting
        </div>
      </div>

      <div style={{ display: "flex", gap: 40 }}>
        {PILLARS.map((p, i) => (
          <Card key={p.title} pillar={p} delay={(0.5 + i * 0.25) * fps} />
        ))}
      </div>
    </AbsoluteFill>
  );
};
