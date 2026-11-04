import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        void: "#07060f",
        panel: "#100e1f",
        edge: "#2a2550",
        neon: {
          green: "#39ff88",
          pink: "#ff3df2",
          cyan: "#2ee6ff",
          amber: "#ffc83d",
          red: "#ff4d5e",
        },
        ink: "#e8e6ff",
        mute: "#8c88b8",
      },
      fontFamily: {
        pixel: ['"Press Start 2P"', "monospace"],
        term: ["VT323", "monospace"],
      },
      boxShadow: {
        "glow-green": "0 0 12px rgba(57,255,136,0.55)",
        "glow-pink": "0 0 12px rgba(255,61,242,0.55)",
        "glow-cyan": "0 0 12px rgba(46,230,255,0.55)",
        pixel: "4px 4px 0 0 #000",
      },
    },
  },
  plugins: [],
};

export default config;
