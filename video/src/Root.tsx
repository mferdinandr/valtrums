import { Composition } from "remotion";
import { DemoVideo, getDemoDurationInFrames } from "./DemoVideo";
import { fps } from "./brand";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="ValtrumDemo"
        component={DemoVideo}
        durationInFrames={getDemoDurationInFrames()}
        fps={fps}
        width={1920}
        height={1080}
      />
    </>
  );
};
