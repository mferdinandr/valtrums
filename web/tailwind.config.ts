import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        void: "#fcf7ed",
        panel: "#fffdf7",
        edge: "#ded9cd",
        neon: {
          green: "#36775c",
          pink: "#a64e72",
          cyan: "#3b7584",
          amber: "#91682d",
          red: "#b34550",
        },
        ink: "#354358",
        mute: "#66747e",
      },
      fontFamily: {
        pixel: ['"Bricolage Grotesque"', "sans-serif"],
        term: ["Figtree", "sans-serif"],
      },
      fontSize: {
        sm: ["15px", "1.6"],
      },
      boxShadow: {
        "glow-green": "0 0 12px rgba(208,245,112,0.2)",
        "glow-pink": "0 0 12px rgba(200,166,247,0.2)",
        "glow-cyan": "0 0 12px rgba(167,204,192,0.2)",
        pixel: "4px 4px 0 0 #000",
      },
    },
  },
  plugins: [],
};

export default config;
