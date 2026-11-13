import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { ProblemStatement } from "./scenes/ProblemStatement";
import { Intro } from "./scenes/Intro";
import { ClipScene } from "./scenes/ClipScene";
import { NearTech } from "./scenes/NearTech";
import { AppDemoPlaceholder } from "./scenes/AppDemoPlaceholder";
import { CtaOutro } from "./scenes/CtaOutro";

// --- scene lengths (frames @ 30fps). Inline + editable. ---
export const PROBLEM_DURATION = 90; // 3.0s — the "why"
export const INTRO_DURATION = 90; // 3.0s
export const CLIP_DURATION = 150; // 5.0s each (matches the grok clips)
export const NEAR_DURATION = 150; // 5.0s — the NEAR tech story
export const APP_DEMO_DURATION = 120; // 4.0s — resize to your recording
export const OUTRO_DURATION = 120; // 4.0s — CTA + links
export const TRANSITION_DURATION = 20; // fade length
const TRANSITIONS = 7; // between the 8 scenes

export const getDemoDurationInFrames = () =>
  PROBLEM_DURATION +
  INTRO_DURATION +
  CLIP_DURATION * 3 +
  NEAR_DURATION +
  APP_DEMO_DURATION +
  OUTRO_DURATION -
  TRANSITIONS * TRANSITION_DURATION;

const fadeT = () => (
  <TransitionSeries.Transition
    presentation={fade()}
    timing={linearTiming({ durationInFrames: TRANSITION_DURATION })}
  />
);

export const DemoVideo: React.FC = () => {
  return (
    <TransitionSeries>
      <TransitionSeries.Sequence
        durationInFrames={PROBLEM_DURATION}
        name="Problem"
      >
        <ProblemStatement />
      </TransitionSeries.Sequence>
      {fadeT()}
      <TransitionSeries.Sequence durationInFrames={INTRO_DURATION} name="Intro">
        <Intro />
      </TransitionSeries.Sequence>
      {fadeT()}
      <TransitionSeries.Sequence durationInFrames={CLIP_DURATION} name="Hook">
        <ClipScene
          src="hook.mp4"
          step="01"
          caption="Any community can enter the open arena"
        />
      </TransitionSeries.Sequence>
      {fadeT()}
      <TransitionSeries.Sequence durationInFrames={CLIP_DURATION} name="Mechanic">
        <ClipScene
          src="mekanik.mp4"
          step="02"
          caption="Pick a scoring mode — battle in adjustable rounds"
        />
      </TransitionSeries.Sequence>
      {fadeT()}
      <TransitionSeries.Sequence durationInFrames={CLIP_DURATION} name="Payoff">
        <ClipScene
          src="payoff.mp4"
          step="03"
          caption="The winning community takes the losing tokens"
        />
      </TransitionSeries.Sequence>
      {fadeT()}
      <TransitionSeries.Sequence durationInFrames={NEAR_DURATION} name="NearTech">
        <NearTech />
      </TransitionSeries.Sequence>
      {fadeT()}
      <TransitionSeries.Sequence
        durationInFrames={APP_DEMO_DURATION}
        name="AppDemoPlaceholder"
      >
        <AppDemoPlaceholder />
      </TransitionSeries.Sequence>
      {fadeT()}
      <TransitionSeries.Sequence durationInFrames={OUTRO_DURATION} name="CtaOutro">
        <CtaOutro />
      </TransitionSeries.Sequence>
    </TransitionSeries>
  );
};
