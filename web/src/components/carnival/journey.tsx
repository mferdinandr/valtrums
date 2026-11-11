"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import gsap from "gsap";
import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowUpRight,
  Sparkles,
  X,
  Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { CONTENDERS } from "@/components/colosseum/choreography";
import {
  CHAPTERS,
  chapterAt,
  chapterOpacity,
  journeyProgress,
} from "./journey-path";

const World = dynamic(() => import("./journey-world"), { ssr: false });
class JourneyBoundary extends Component<
  { children: ReactNode; onFailure: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    console.error("Valtrum 3D journey failed", error);
    this.props.onFailure();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function IllustratedWorld() {
  return (
    <svg
      viewBox="0 0 1600 1000"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <rect width="1600" height="1000" fill="#d4eae7" />
      <ellipse cx="200" cy="900" rx="700" ry="340" fill="#c4dbb4" />
      <ellipse cx="1430" cy="890" rx="750" ry="300" fill="#b2cfa8" />
      <path d="M650 1000 730 610H870L1070 1000" fill="#f8e6c2" />
      {[180, 340, 1260, 1430].map((x, i) => (
        <g key={x} transform={`translate(${x} ${i % 2 ? 630 : 720})`}>
          <rect
            x="-12"
            y="-50"
            width="24"
            height="170"
            rx="10"
            fill="#b99370"
          />
          <circle cy="-70" r="82" fill="#98bf8c" />
          <circle cx="-40" cy="-35" r="55" fill="#afd193" />
          <circle cx="45" cy="-45" r="56" fill="#afd193" />
        </g>
      ))}
      <rect x="495" y="450" width="50" height="320" rx="20" fill="#f4a18f" />
      <rect x="1055" y="450" width="50" height="320" rx="20" fill="#f4a18f" />
      <rect x="490" y="410" width="620" height="80" rx="30" fill="#c5b5e2" />
      <rect x="600" y="430" width="400" height="38" rx="14" fill="#fff3db" />
      <path
        d="M545 750V590Q670 550 790 590V750M810 750V590Q935 550 1055 590V750"
        fill="#a6cfbb"
        stroke="#fff3db"
        strokeWidth="12"
      />
      <circle cx="520" cy="414" r="27" fill="#f0c66b" />
      <circle cx="1080" cy="414" r="27" fill="#f0c66b" />
      <path
        d="M340 380Q800 540 1260 380"
        fill="none"
        stroke="#b99370"
        strokeWidth="3"
      />
      {Array.from({ length: 13 }, (_, i) => (
        <path
          key={i}
          d={`M${370 + i * 67} ${400 + Math.sin((i / 12) * Math.PI) * 60}l30 3-18 35z`}
          fill={["#f4a18f", "#a6cfbb", "#c5b5e2", "#f0c66b"][i % 4]}
        />
      ))}
    </svg>
  );
}

export function LandingJourney() {
  const createPath = "/arena/new";
  const rail = useRef<HTMLElement>(null),
    chapters = useRef<HTMLElement>(null),
    details = useRef<HTMLDialogElement>(null),
    hashDetails = useRef(false),
    router = useRouter();
  const [progress, setProgress] = useState(0),
    [reduced, setReduced] = useState(false),
    [compact, setCompact] = useState(false),
    [active, setActive] = useState(true),
    [seen, setSeen] = useState(false),
    [supported, setSupported] = useState(false),
    [loaded, setLoaded] = useState(false),
    [failed, setFailed] = useState(false),
    [selected, setSelected] = useState(0),
    [topic, setTopic] = useState<"rules" | "planned" | null>(null);
  const onReady = useCallback(() => setLoaded(true), []),
    onFailure = useCallback(() => setFailed(true), []),
    navigate = useCallback((path: string) => router.push(path), [router]);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const shortScreen = matchMedia("(max-height: 500px)");
    const motion = () => {
      setReduced(media.matches);
      setCompact(shortScreen.matches);
    };
    motion();
    media.addEventListener("change", motion);
    shortScreen.addEventListener("change", motion);
    let request = 0;
    const measure = () => {
      request = 0;
      if (!rail.current) return;
      const rect = rail.current.getBoundingClientRect();
      setProgress(journeyProgress(rect.top, rect.height, innerHeight));
      const inView =
        !document.hidden && rect.bottom > 0 && rect.top < innerHeight;
      setActive(inView);
      if (inView) setSeen(true);
    };
    const schedule = () => {
      if (!request) request = requestAnimationFrame(measure);
    };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    document.addEventListener("visibilitychange", schedule);
    const observer = new ResizeObserver(schedule);
    if (rail.current) observer.observe(rail.current);
    measure();
    // Canvas owns context creation and reports failures through the boundary.
    setSupported(true);
    return () => {
      media.removeEventListener("change", motion);
      shortScreen.removeEventListener("change", motion);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("visibilitychange", schedule);
      observer.disconnect();
      cancelAnimationFrame(request);
    };
  }, []);
  useEffect(() => {
    if (!rail.current) return;
    const rect = rail.current.getBoundingClientRect();
    setProgress(journeyProgress(rect.top, rect.height, innerHeight));
  }, [reduced, compact]);
  const staticMode = reduced || compact || failed;
  const current = chapterAt(progress),
    crew = CONTENDERS[selected] ?? CONTENDERS[0]!;
  useEffect(() => {
    if (
      staticMode ||
      matchMedia("(prefers-reduced-motion: reduce)").matches ||
      !rail.current
    )
      return;
    const context = gsap.context(() => {
      const panel = document.getElementById(
        `carnival-${CHAPTERS[current]!.id}`,
      );
      if (!panel) return;
      gsap.fromTo(
        panel.querySelectorAll(
          ":scope > .journey-tag, :scope > h1, :scope > h2, :scope > p, :scope > .journey-actions, :scope > .journey-crew, :scope > nav",
        ),
        { y: 10, opacity: 0 },
        {
          y: 0,
          opacity: 1,
          duration: 0.65,
          stagger: 0.055,
          ease: "power2.out",
          clearProps: "opacity,transform",
        },
      );
    }, rail);
    return () => context.revert();
  }, [current, staticMode]);
  useEffect(() => {
    const nav = chapters.current;
    const button = nav?.children[current] as HTMLElement | undefined;
    if (!nav || !button) return;
    nav.scrollTo({
      left:
        button.offsetLeft -
        nav.offsetLeft -
        (nav.clientWidth - button.clientWidth) / 2,
      behavior: reduced ? "auto" : "smooth",
    });
  }, [current, reduced]);
  const panelProps = (index: number) => ({
    className: `journey-panel journey-panel-${index}`,
    inert: !staticMode && current !== index,
    "aria-hidden": !staticMode && current !== index,
    style: staticMode
      ? undefined
      : {
          opacity: chapterOpacity(progress, index),
          visibility:
            current === index ? ("visible" as const) : ("hidden" as const),
          transform: `translateY(${(1 - chapterOpacity(progress, index)) * 12}px)`,
        },
  });
  const goTo = useCallback(
    (index: number) => {
      if (!rail.current) return;
      if (staticMode) {
        document
          .getElementById(`carnival-${CHAPTERS[index]!.id}`)
          ?.scrollIntoView({ behavior: "auto", block: "start" });
        return;
      }
      const rect = rail.current.getBoundingClientRect(),
        top = window.scrollY + rect.top;
      window.scrollTo({
        top: top + CHAPTERS[index]!.at * Math.max(0, rect.height - innerHeight),
        behavior: "smooth",
      });
    },
    [staticMode],
  );
  useEffect(() => {
    const followHash = () => {
      if (location.hash === "#product-flow") {
        hashDetails.current = true;
        setTopic("planned");
      } else if (location.hash === "#mechanics") {
        hashDetails.current = true;
        setTopic("rules");
      } else if (location.hash === "#welcome-details")
        goTo(CHAPTERS.length - 1);
      else if (hashDetails.current) {
        hashDetails.current = false;
        details.current?.close();
        setTopic(null);
      }
    };
    followHash();
    window.addEventListener("hashchange", followHash);
    return () => window.removeEventListener("hashchange", followHash);
  }, [goTo]);
  useEffect(() => {
    if (!topic || !details.current) return;
    details.current.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [topic]);
  const closeDetails = () => {
    hashDetails.current = false;
    details.current?.close();
    setTopic(null);
    if (["#product-flow", "#mechanics"].includes(location.hash))
      history.replaceState(
        history.state,
        "",
        location.pathname + location.search,
      );
  };
  return (
    <section
      ref={rail}
      className="landing-journey"
      data-reduced={staticMode}
      aria-label="Explore the living world of Valtrum"
    >
      <div className="journey-stage">
        <div
          className="journey-world"
          role="group"
          aria-label="A decorative 3D journey through Valtrum: community plaza, Create Battle machine, arena, vaults and a final town vista. All destinations are linked in the page text."
        >
          {supported && seen && !failed && (
            <JourneyBoundary onFailure={onFailure}>
              <World
                progress={progress}
                reduced={reduced || compact}
                ambientPaused={false}
                active={active && !topic}
                selected={selected}
                onSelect={setSelected}
                onNavigate={navigate}
                onReady={onReady}
                onFailure={onFailure}
              />
            </JourneyBoundary>
          )}
          <div
            className={`journey-poster ${loaded && !failed ? "journey-poster-hidden" : ""}`}
          >
            <IllustratedWorld />
          </div>
        </div>
        <div
          className={`journey-shade journey-shade-${current}`}
          aria-hidden="true"
        />
        <div className="journey-panels">
          <section
            id="carnival-arrival"
            {...panelProps(0)}
            aria-labelledby="journey-title"
          >
            <span className="journey-tag">
              <Sparkles size={13} /> Welcome to the world of Valtrum
            </span>
            <h1 id="journey-title">
              A little world.
              <br />
              <em>Big community energy.</em>
            </h1>
            <p>
              Step into a playful home for token communities. Find your crew,
              explore the battles, or try the wallet-free carnival.
            </p>
            <div className="journey-actions">
              <Button asChild size="lg">
                <Link href="/arena">
                  Explore battles <ArrowUpRight size={16} />
                </Link>
              </Button>
              <Button asChild variant="cyan" size="lg">
                <Link href={createPath}>
                  Create a battle <ArrowUpRight size={14} />
                </Link>
              </Button>
            </div>
            <button className="journey-scroll-cue" onClick={() => goTo(1)}>
              <ArrowDown size={16} /> Scroll to enter the world
            </button>
          </section>
          <section
            id="carnival-gateway"
            {...panelProps(1)}
            aria-labelledby="journey-gateway-title"
          >
            <span className="journey-tag">Through the gates</span>
            <h2 id="journey-gateway-title">
              Come on in.
              <br />
              Bring your curiosity.
            </h2>
            <p>
              Every community brings a different personality. Meet the mascots,
              inspect the rules, and choose your own way into Valtrum.
            </p>
          </section>
          <section
            id="carnival-community"
            {...panelProps(2)}
            aria-labelledby="journey-community-title"
          >
            <span className="journey-tag">A place for your crew</span>
            <h2 id="journey-community-title">
              Many personalities.
              <br />
              One friendly rivalry.
            </h2>
            <p>
              Each crew has its own reactor station. Open a battle to meet its
              communities, follow the chart and watch the action in one arena.
            </p>
            <div
              className="journey-crew"
              role="group"
              aria-label="Meet a community mascot"
            >
              {CONTENDERS.map((c, i) => (
                <button
                  key={c.asset}
                  aria-pressed={selected === i}
                  style={{ "--crew": c.color } as React.CSSProperties}
                  onClick={() => setSelected(i)}
                >
                  {c.name}
                </button>
              ))}
            </div>
            <p className="journey-small" role="status">
              <strong>{crew.title}.</strong> {crew.description}
            </p>
          </section>
          <section
            id="carnival-create"
            {...panelProps(3)}
            aria-labelledby="journey-create-title"
          >
            <span className="journey-tag">Create Battle</span>
            <h2 id="journey-create-title">
              A rivalry starts
              <br />
              with an idea.
            </h2>
            <p>
              Pick your communities, choose a challenge, and review the details
              before your wallet signs.
            </p>
            <div className="journey-actions">
              <Button asChild>
                <Link href={createPath}>
                  Create a battle <ArrowUpRight size={16} />
                </Link>
              </Button>
              <button
                className="journey-text-link"
                onClick={() => setTopic("rules")}
              >
                How it works <Info size={13} />
              </button>
            </div>
          </section>
          <section
            id="carnival-overlook"
            {...panelProps(4)}
            aria-labelledby="journey-overlook-title"
          >
            <span className="journey-tag">The Arena</span>
            <h2 id="journey-overlook-title">
              Big personalities.
              <br />
              Personal challenges.
            </h2>
            <p>
              Pick a crew. Follow the chart. Watch the round unfold.
            </p>
            <div className="journey-actions">
              <Button asChild variant="cyan">
                <Link href="/arena">
                  Find a battle <ArrowUpRight size={14} />
                </Link>
              </Button>
            </div>
          </section>
          <section
            id="carnival-vault"
            {...panelProps(5)}
            aria-labelledby="journey-vault-title"
          >
            <span className="journey-tag">Your Portfolio</span>
            <h2 id="journey-vault-title">
              Your journey.
              <br />
              Every receipt.
            </h2>
            <p>
              Follow your positions, review the outcome, then claim or withdraw
              when the current arena makes those actions available.
            </p>
            <div className="journey-actions">
              <Button asChild variant="cyan">
                <Link href="/portfolio">
                  Open Portfolio <ArrowUpRight size={16} />
                </Link>
              </Button>
            </div>
            <nav className="journey-destinations" aria-label="Portfolio help">
              <Link href="/terminal">Review an intent in Terminal ↗</Link>
              <button
                className="journey-text-link"
                onClick={() => setTopic("rules")}
              >
                Read the current flow
              </button>
            </nav>
          </section>
          <section
            id="carnival-events"
            {...panelProps(6)}
            aria-labelledby="journey-events-title"
          >
            <span className="journey-tag">Your next chapter</span>
            <h2 id="journey-events-title">
              The world is open.
              <br />
              Where to next?
            </h2>
            <p>
              Choose a testnet battle to enter its 3D arena, follow the chart
              and inspect its rules. Watching requires no wallet.
            </p>
            <div className="journey-actions">
              <Button asChild size="lg">
                <Link href="/arena">
                  Find a battle <ArrowUpRight size={16} />
                </Link>
              </Button>
              <Button asChild variant="cyan" size="lg">
                <Link href={createPath}>
                  Create a battle <ArrowUpRight size={14} />
                </Link>
              </Button>
            </div>
            <nav
              className="journey-destinations"
              aria-label="Festival destinations"
            >
              <Link href={createPath}>Create Battle ↗</Link>
              <Link href="/portfolio">Your portfolio ↗</Link>
              <Link href="/terminal">Terminal ↗</Link>
              <button
                className="journey-text-link"
                onClick={() => setTopic("planned")}
              >
                What’s next for Valtrum?
              </button>
            </nav>
            <p className="journey-endnote">
              Built on NEAR · Testnet experience
            </p>
          </section>
        </div>
        <div className="journey-bottom-bar">
          <nav
            ref={chapters}
            aria-label="Journey chapters"
            className="journey-chapters"
          >
            {CHAPTERS.map((chapter, i) => (
              <button
                key={chapter.id}
                aria-current={!staticMode && current === i ? "step" : undefined}
                onClick={() => goTo(i)}
              >
                <span>{String(i + 1).padStart(2, "0")}</span>
                {chapter.label}
              </button>
            ))}
          </nav>
          <div className="journey-controls">
            <button
              className="journey-skip"
              onClick={() => goTo(CHAPTERS.length - 1)}
            >
              Skip journey <ArrowDown size={12} />
            </button>
          </div>
        </div>
        {failed && <p className="journey-render-note"><button type="button" onClick={() => { setLoaded(false); setFailed(false); }}>Try loading the world again</button></p>}
        {!staticMode && (
          <div className="journey-progress" aria-hidden="true">
            <span style={{ transform: `scaleX(${progress})` }} />
          </div>
        )}
      </div>
      <dialog
        ref={details}
        className="journey-dialog"
        aria-labelledby="journey-detail-title"
        onCancel={closeDetails}
        onClose={() => setTopic(null)}
      >
        <div className="journey-dialog-top">
          <span className="journey-tag">Valtrum / Field notes</span>
          <button
            autoFocus
            aria-label="Close field notes"
            onClick={closeDetails}
          >
            <X size={20} />
          </button>
        </div>
        <h2 id="journey-detail-title">
          {topic === "planned" ? "The next chapter." : "Know your next move."}
        </h2>
        {topic === "planned" ? (
          <>
            <p className="journey-note-label">
              Target design · not the current wallet flow
            </p>
            <p>
              The planned arena brings two or more approved communities
              together. The creator selects one of four modes and participates
              with a positive backed deposit.
            </p>
            <ol>
              <li>
                <strong>Four modes.</strong> Price % Gain, Market Cap % Growth,
                Volume-to-Market Cap Ratio, or Lowest % Drawdown.
              </li>
              <li>
                <strong>Fresh overtime.</strong> Thirty-second rounds; tied
                leaders continue with fresh baselines and no overtime cap. All
                original vaults stay locked until a final winner.
              </li>
              <li>
                <strong>Original-token rewards.</strong> Winners receive
                separate entitlements in the original losing tokens,
                proportional to their locked winning position. Availability, a
                pending transfer and confirmed receipt are different states.
              </li>
              <li>
                <strong>Principal in escrow.</strong> Winning principal awaits a
                DAO burn-or-return decision. Governance rules remain open.
              </li>
            </ol>
            <p>
              Robinhood source-token payouts and bounded, user-funded player
              agents are part of the target. A simulated demo does not prove
              these live integrations.
            </p>
          </>
        ) : (
          <>
            <p className="journey-note-label">
              Current wallet app · integrated 3D battle arena
            </p>
            <ol>
              <li>
                <strong>Inspect first.</strong> Read community contracts, audit
                status, rules and deposit windows. Mascots are original
                interpretations and never establish token eligibility.
              </li>
              <li>
                <strong>Create and review.</strong> The current form selects two
                token contracts, a duration and a USDC proposal bond. Review the
                amount and wallet summary before signing.
              </li>
              <li>
                <strong>Follow the position.</strong> The current settlement
                retains its 55/35/5/5 allocation and seven-day credit. Portfolio
                exposes the applicable claim, refund and withdrawal actions;
                claiming and withdrawing are separate steps.
              </li>
              <li>
                <strong>Enter the arena.</strong> Open a battle to watch its
                communities and chart in one 3D arena. Simulated battles are
                labeled; cosmetic actions never determine the result.
              </li>
            </ol>
            <p>
              Deposited tokens can be lost. Decorative capsules, vaults and
              score animations on this landing never represent a wallet
              transaction.
            </p>
          </>
        )}
        <div className="journey-actions">
          <Button asChild>
            <Link href="/arena">
              Explore battles <ArrowUpRight size={15} />
            </Link>
          </Button>
          <Button asChild variant="cyan">
            <Link href="/portfolio">
              Open Portfolio <ArrowUpRight size={14} />
            </Link>
          </Button>
        </div>
      </dialog>
    </section>
  );
}
