"use client";

import { useEffect, useId, useState } from "react";

/** Renders a Mermaid diagram in the site palette. The diagram source is the `chart` string. */
export function Mermaid({ chart, caption }: { chart: string; caption?: string }) {
  const id = "mmd" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          fontFamily: "Figtree, sans-serif",
          themeVariables: {
            background: "#fffdf7",
            primaryColor: "#e2ede2",
            primaryBorderColor: "#a6c9b3",
            primaryTextColor: "#354358",
            secondaryColor: "#f8ecd7",
            tertiaryColor: "#fffdf7",
            lineColor: "#66747e",
            textColor: "#354358",
            clusterBkg: "#f3eee3",
            clusterBorder: "#ded9cd",
            edgeLabelBackground: "#fffdf7",
          },
        });
        const out = await mermaid.render(id, chart);
        if (live) setSvg(out.svg);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [chart, id]);

  return (
    <figure className="widget" style={{ margin: "1.5rem 0", overflowX: "auto", textAlign: "center" }}>
      {svg ? (
        <div dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <pre style={{ textAlign: "left", whiteSpace: "pre-wrap", color: "var(--mute)", fontSize: "0.85rem" }}>
          {failed ? chart : "Loading diagram…"}
        </pre>
      )}
      {caption ? <figcaption style={{ color: "var(--mute)", fontSize: "0.85rem", marginTop: "0.5rem" }}>{caption}</figcaption> : null}
    </figure>
  );
}
