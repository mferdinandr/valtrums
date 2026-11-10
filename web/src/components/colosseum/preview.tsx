"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Crosshair,
  Expand,
  Eye,
  Pause,
  Play,
  RotateCcw,
  Shield,
  Sparkles,
  Swords,
  Trophy,
  LockKeyhole,
  Settings2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MODES,
  ROUND_SECONDS,
  exhibitionCaption,
  formatScore,
  makeRuntime,
  rosterFor,
  roundAt,
  type CameraMode,
  type PreviewPhase,
  type ScoreMode,
  type Scenario,
} from "./choreography";

const Scene = dynamic(() => import("./scene"), { ssr: false });
class RenderBoundary extends Component<
  { children: ReactNode; onFailure: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onFailure();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function ColosseumPreview() {
  const root = useRef<HTMLDivElement>(null),
    primary = useRef<HTMLButtonElement>(null),
    settings = useRef<HTMLDetailsElement>(null);
  const runtime = useRef(makeRuntime());
  const [count, setCount] = useState(5),
    [mode, setMode] = useState<ScoreMode>("gain"),
    [scenario, setScenario] = useState<Scenario>("overtime"),
    [speed, setSpeed] = useState(3);
  const roster = useMemo(() => rosterFor(count), [count]);
  const [phase, setPhase] = useState<PreviewPhase>("intro"),
    [selected, setSelected] = useState(0),
    [camera, setCamera] = useState<CameraMode>("overview");
  const [paused, setPaused] = useState(false),
    [reduced, setReduced] = useState(false),
    [systemReduced, setSystemReduced] = useState(false),
    [visible, setVisible] = useState(true);
  const [support, setSupport] = useState<"checking" | "webgl" | "fallback">(
      "checking",
    ),
    [sceneReady, setSceneReady] = useState(false);
  const [elapsed, setElapsed] = useState(0),
    [evidenceReady, setEvidenceReady] = useState(false),
    [session, setSession] = useState(0),
    [notice, setNotice] = useState("");
  runtime.current.selected = selected;
  runtime.current.camera = camera;
  runtime.current.reduced = reduced;
  runtime.current.paused = paused || !visible;
  runtime.current.roster = roster;
  runtime.current.mode = mode;
  runtime.current.scenario = scenario;
  runtime.current.evidenceReady = evidenceReady;
  const contender = roster[selected] ?? roster[0]!;
  const snapshot = roundAt({ ...runtime.current, time: elapsed });
  const winner = snapshot.winner === null ? null : roster[snapshot.winner]!;
  const started = phase === "battle" || phase === "result";

  const changePhase = (next: PreviewPhase) => {
    runtime.current.phase = next;
    runtime.current.time = 0;
    setElapsed(0);
    setPhase(next);
  };
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setSystemReduced(media.matches);
      setReduced(media.matches);
    };
    update();
    media.addEventListener("change", update);
    const visibility = () => setVisible(!document.hidden);
    visibility();
    document.addEventListener("visibilitychange", visibility);
    const context = document.createElement("canvas").getContext("webgl2");
    if (context) {
      context.getExtension("WEBGL_lose_context")?.loseContext();
      setSupport("webgl");
    } else {
      setSupport("fallback");
      changePhase("ready");
    }
    return () => {
      media.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  useEffect(() => {
    if (reduced && runtime.current.phase === "intro") changePhase("ready");
  }, [reduced]);
  useEffect(() => {
    if (
      phase === "ready" ||
      phase === "result" ||
      paused ||
      !visible ||
      support === "checking" ||
      (support === "webgl" && !sceneReady)
    )
      return;
    let frame = 0,
      previous = performance.now(),
      lastPaint = previous;
    const tick = (now: number) => {
      const delta = Math.max(0, (now - previous) / 1000);
      previous = now;
      const state = runtime.current;
      if (phase === "intro") {
        state.time += delta;
        if (state.time >= 3) {
          state.time = 0;
          state.phase = "ready";
          setElapsed(0);
          setPhase("ready");
          return;
        }
      } else {
        if (roundAt(state).stage !== "pending") state.time += delta * speed;
        const round = roundAt(state);
        if (round.stage === "pending") state.time = ROUND_SECONDS;
        if (round.stage === "result") {
          state.phase = "result";
          setElapsed(state.time);
          setPhase("result");
          return;
        }
      }
      if (now - lastPaint > 100) {
        setElapsed(state.time);
        lastPaint = now;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase, paused, visible, support, sceneReady, speed]);
  const choose = (index: number) => {
    setSelected(index);
    if (phase !== "intro") setCamera("follow");
  };
  const replay = () => {
    setPaused(false);
    setEvidenceReady(false);
    setCamera("overview");
    changePhase("ready");
    primary.current?.focus({ preventScroll: true });
  };
  const fullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (root.current?.requestFullscreen)
        await root.current.requestFullscreen();
      else setNotice("Use the browser fullscreen control on this device.");
    } catch {
      setNotice(
        "Fullscreen is unavailable. The arena still fits the browser window.",
      );
    }
  };
  const event =
    phase === "battle" || phase === "result"
      ? exhibitionCaption({ ...runtime.current, time: elapsed })
      : phase === "intro"
        ? "Entering Reactor Colosseum"
        : "Choose a contender or configure the exhibition.";
  const latest = snapshot.history.at(-1);
  const rankingScores = snapshot.scores.length
    ? snapshot.scores
    : (latest?.scores ?? []);
  const revealScores =
    snapshot.stage === "result" || snapshot.stage === "overtime";
  const standingOrder = roster
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const left = rankingScores.find((s) => s.participant === a.i),
        right = rankingScores.find((s) => s.participant === b.i);
      if (!revealScores)
        return (
          Number(snapshot.eliminated.includes(a.i)) -
          Number(snapshot.eliminated.includes(b.i))
        );
      if (!left || !right) return left ? -1 : right ? 1 : a.i - b.i;
      const difference = left.n * right.d - right.n * left.d;
      return difference === 0n
        ? a.i - b.i
        : (difference > 0n ? -1 : 1) * (mode === "drawdown" ? -1 : 1);
    });
  const statusFor = (index: number) =>
    !started
      ? "Ready"
      : winner
        ? snapshot.winner === index
          ? "Winner"
          : "Eliminated · vault locked"
        : snapshot.eliminated.includes(index)
          ? "Eliminated · vault locked"
          : snapshot.stage === "pending"
            ? "Awaiting evidence"
            : snapshot.stage === "overtime"
              ? "Advances · vault locked"
              : "In contention";

  return (
    <div
      ref={root}
      className="colosseum-preview"
      data-phase={phase}
      data-stage={snapshot.stage}
      style={{ "--team": contender.color } as React.CSSProperties}
    >
      <div
        className="colosseum-world"
        aria-label={`3D exhibition arena with ${count} mechanical contenders. Select a character with the buttons below.`}
      >
        {support === "webgl" && (
          <RenderBoundary
            key={session}
            onFailure={() => setSupport("fallback")}
          >
            <Scene
              key={count}
              runtime={runtime}
              frozen={paused || !visible || reduced}
              onReady={() => setSceneReady(true)}
              onFailure={() => setSupport("fallback")}
              onSelect={choose}
            />
          </RenderBoundary>
        )}
        {(support === "checking" || (support === "webgl" && !sceneReady)) && (
          <div className="colosseum-loading">
            <span className="colosseum-loader" />
            <p>Assembling the colosseum</p>
            <small>Loading {count} local GLB character instances</small>
          </div>
        )}
        {support === "fallback" && (
          <div className="colosseum-fallback">
            <Shield size={40} />
            <h2>Exhibition command view</h2>
            <p>
              3D is unavailable. Round results, selection and controls remain
              available.
            </p>
            <div className="colosseum-fallback-roster">
              {roster.map((c, i) => (
                <span key={c.number} style={{ color: c.color }}>
                  {c.number}
                  <strong>{c.name}</strong>
                  {statusFor(i)}
                </span>
              ))}
            </div>
            <Button
              variant="ghost"
              onClick={() => {
                setSceneReady(false);
                setSession((v) => v + 1);
                setSupport("webgl");
              }}
            >
              Retry 3D
            </Button>
          </div>
        )}
      </div>
      <div className="colosseum-vignette" />
      <header className="colosseum-topbar">
        <Link href="/arena" aria-label="Exit arena" className="colosseum-back">
          <ArrowLeft size={16} />
          <span>Exit arena</span>
        </Link>
        <div className="colosseum-brand">
          <span>VALTRUM / EXPERIMENT 02</span>
          <strong>TOKEN CARNIVAL</strong>
        </div>
        <span className="colosseum-preview-label">
          <span /> Scripted preview
        </span>
      </header>
      <section className="colosseum-heading" aria-label="Exhibition status">
        <p className="colosseum-kicker">
          SECTOR 07 / {count} CONTENDERS / {speed}× PLAYBACK
        </p>
        <h1>
          {winner
            ? "Big cheers, little crew!"
            : phase === "battle"
              ? snapshot.stage === "overtime"
                ? "Encore, encore!"
                : snapshot.stage === "pending"
                  ? "A little intermission."
                  : "Make some noise!"
              : "Small crews. Big energy."}
        </h1>
        <p>
          {winner
            ? `${winner.name} takes the spotlight.`
            : started
              ? `${MODES[mode]} · Round ${snapshot.round}`
              : `${count} colorful crews. One friendly rivalry.`}
        </p>
      </section>
      <div className="colosseum-tools" role="group" aria-label="Arena controls">
        <button
          aria-label="Overview camera"
          aria-pressed={camera === "overview"}
          onClick={() => setCamera("overview")}
        >
          <Eye size={17} />
        </button>
        <button
          aria-label="Follow selected contender"
          aria-pressed={camera === "follow"}
          onClick={() => setCamera("follow")}
        >
          <Crosshair size={17} />
        </button>
        <button
          aria-label={paused ? "Resume exhibition" : "Pause exhibition"}
          aria-pressed={paused}
          onClick={() => setPaused((v) => !v)}
        >
          {paused ? <Play size={17} /> : <Pause size={17} />}
        </button>
        <button
          aria-label="Reduced effects"
          aria-pressed={reduced}
          disabled={systemReduced}
          onClick={() => setReduced((v) => !v)}
        >
          <Sparkles size={17} />
        </button>
        <button aria-label="Toggle fullscreen" onClick={fullscreen}>
          <Expand size={17} />
        </button>
      </div>

      {!started && (
        <details ref={settings} className="colosseum-setup">
          <summary>
            <Settings2 size={14} /> Exhibition setup <span>{count} units</span>
          </summary>
          <div>
            <label>
              Participants
              <select
                aria-label="Exhibition participants"
                value={count}
                disabled={phase === "intro"}
                onChange={(e) => {
                  setCount(Number(e.target.value));
                  setSelected(0);
                  setCamera("overview");
                  if (support === "webgl") setSceneReady(false);
                }}
              >
                <option value={2}>2 · Duel</option>
                <option value={3}>3 · Trio</option>
                <option value={5}>5 · All demo communities</option>
                <option value={6}>6 · Layout test (one synthetic unit)</option>
              </select>
            </label>
            <label>
              Scoring mode
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as ScoreMode)}
              >
                {Object.entries(MODES).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Scripted scenario
              <select
                value={scenario}
                onChange={(e) => setScenario(e.target.value as Scenario)}
              >
                <option value="overtime">
                  Repeated ties → overtime → winner
                </option>
                <option value="clean">Unique winner in round 1</option>
                <option value="missing">Missing evidence → hold</option>
              </select>
            </label>
            <label>
              Playback speed
              <select
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
              >
                <option value={1}>1× · 30 real seconds per round</option>
                <option value={3}>3× · 10 real seconds per round</option>
              </select>
            </label>
            <p>
              Fixtures only. Modes and participant set lock when the exhibition
              starts. The sixth unit tests layout and represents no token.
            </p>
          </div>
        </details>
      )}

      {started && (
        <details className="colosseum-standings">
          <summary>
            ROUND {snapshot.round}
            <span>{snapshot.candidates.length} in contention</span>
          </summary>
          <div>
            <p className="colosseum-ranking-note">
              {snapshot.stage === "fighting"
                ? "Fresh round. Scores appear after fixture verification."
                : snapshot.stage === "pending"
                  ? "Missing evidence · no result assigned"
                  : snapshot.stage === "resolving"
                    ? "Verifying round evidence…"
                    : "Verified fixture result · not market data"}
            </p>
            {standingOrder.map(({ c, i }) => {
              const score = (
                snapshot.scores.length
                  ? snapshot.scores
                  : (latest?.scores ?? [])
              ).find((s) => s.participant === i);
              const reveal =
                snapshot.stage === "result" || snapshot.stage === "overtime";
              return (
                <div className="colosseum-ranking-row" key={c.number}>
                  <span style={{ color: c.color }}>
                    {c.name}
                    <small>{statusFor(i)}</small>
                  </span>
                  <strong>
                    {reveal && score ? formatScore(score, mode) : "—"}
                  </strong>
                </div>
              );
            })}
            <p className="colosseum-vault-note">
              <LockKeyhole size={12} /> All original vaults remain locked.
              Deposits stay closed through overtime.
            </p>
            {snapshot.history.length > 0 && (
              <ol className="colosseum-round-history">
                {snapshot.history.map((record) => (
                  <li key={record.round}>
                    R{record.round}:{" "}
                    {record.leaders.map((i) => roster[i]?.name).join(" + ")}
                    {record.leaders.length > 1 ? " tied" : " won"}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </details>
      )}

      {phase === "intro" && (
        <div className="colosseum-intro">
          <span>ESTABLISHING ARENA LINK</span>
          <strong>Welcome to the carnival!</strong>
          <button
            onClick={() => {
              changePhase("ready");
              primary.current?.focus({ preventScroll: true });
            }}
          >
            Skip intro <ArrowUpRight size={14} />
          </button>
        </div>
      )}
      <aside className="colosseum-dossier" aria-label="Selected contender">
        <span className="colosseum-dossier-index">
          UNIT / {contender.number}
        </span>
        <div>
          <strong>{contender.name}</strong>
          <span>{contender.title}</span>
        </div>
        <p>{contender.description}</p>
        <small>
          {contender.synthetic
            ? "Synthetic layout unit · no token"
            : "Original cosmetic interpretation."}
        </small>
        {started && (
          <small className="colosseum-unit-status">{statusFor(selected)}</small>
        )}
      </aside>

      <div className="colosseum-bottom">
        <div className="colosseum-event">
          <span className="colosseum-event-light" />
          <p>{paused ? "Exhibition paused" : event}</p>
          <span className="sr-only" role="status">
            {paused
              ? "Exhibition paused"
              : started
                ? `Round ${snapshot.round}. ${snapshot.stage}. ${snapshot.candidates.length} in contention.${winner ? ` ${winner.name} wins.` : ""}`
                : phase === "ready"
                  ? "Exhibition ready"
                  : "Entering arena"}
          </span>
          <span className="colosseum-clock">
            {phase === "battle"
              ? snapshot.stage === "fighting"
                ? `R${snapshot.round} / ${Math.ceil(snapshot.remaining).toString().padStart(2, "0")}s`
                : snapshot.stage.toUpperCase()
              : winner
                ? "COMPLETE"
                : "STANDBY"}
          </span>
        </div>
        {phase === "battle" && (
          <div
            className="colosseum-round-progress"
            role="progressbar"
            aria-label={`Round ${snapshot.round} interval`}
            aria-valuemin={0}
            aria-valuemax={30}
            aria-valuenow={Math.floor(snapshot.elapsed)}
          >
            <span style={{ width: `${(snapshot.elapsed / 30) * 100}%` }} />
          </div>
        )}
        {phase === "battle" && snapshot.stage === "pending" && (
          <div className="colosseum-evidence">
            <span>Demo evidence is incomplete. All vaults stay locked.</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEvidenceReady(true)}
            >
              Supply demo evidence
            </Button>
          </div>
        )}
        <div className="colosseum-bottom-main">
          <div
            className="colosseum-roster"
            role="group"
            aria-label="Choose a contender"
          >
            {roster.map((c, index) => (
              <button
                type="button"
                key={c.number}
                onClick={() => choose(index)}
                aria-pressed={selected === index}
                className={
                  snapshot.eliminated.includes(index) && started
                    ? "colosseum-eliminated"
                    : ""
                }
                style={{ "--unit": c.color } as React.CSSProperties}
              >
                <span className="colosseum-unit-emblem">
                  {["⬡", "⋈", "◈", "↻", "⌃", "◇"][index]}
                </span>
                <span>
                  <strong>{c.name}</strong>
                  <small>{started ? statusFor(index) : c.title}</small>
                </span>
                <span className="colosseum-unit-number">{c.number}</span>
              </button>
            ))}
          </div>
          <div className="colosseum-action">
            {winner ? (
              <div className="colosseum-winner">
                <Trophy size={20} />
                <span>
                  <strong>{winner.name} wins</strong>
                  <small>Verified fixture outcome</small>
                </span>
              </div>
            ) : (
              <div className="colosseum-action-copy">
                <span>
                  {started ? "DEPOSITS CLOSED" : "YOUR ARENA IS READY"}
                </span>
                <small>
                  {started
                    ? `Round ${snapshot.round} · ${speed}× playback`
                    : `${ROUND_SECONDS}s rounds · ${speed}× playback`}
                </small>
              </div>
            )}
            <Button
              ref={primary}
              disabled={
                phase === "intro" ||
                support === "checking" ||
                (support === "webgl" && !sceneReady)
              }
              onClick={() => {
                if (started) replay();
                else {
                  if (settings.current) settings.current.open = false;
                  setEvidenceReady(false);
                  setPaused(false);
                  changePhase("battle");
                }
              }}
            >
              {started ? (
                <>
                  <RotateCcw size={16} />
                  {winner ? "Play again" : "Reset"}
                </>
              ) : (
                <>
                  <Swords size={17} />
                  Start exhibition
                </>
              )}
            </Button>
          </div>
        </div>
        <div className="colosseum-disclosure">
          <span>Stage 2 / Multi-community prototype</span>
          <p>
            Personal reactor challenges are cosmetic. Mode scores decide the
            round. Scripted fixtures · {speed}× playback. No wallet or live
            market data.
          </p>
        </div>
        {notice && (
          <p role="status" className="colosseum-notice">
            {notice}
          </p>
        )}
      </div>
    </div>
  );
}
