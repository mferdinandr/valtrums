import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        void: "#101418",
        panel: "#192126",
        edge: "#36434a",
        neon: {
          green: "#d0f570",
          pink: "#c8a6f7",
          cyan: "#a7ccc0",
          amber: "#f0cc86",
          red: "#ff4d5e",
        },
        ink: "#eeefe7",
        mute: "#acb9bd",
      },
      fontFamily: {
        pixel: ['"Space Grotesk"', "sans-serif"],
        term: ["Inter", "sans-serif"],
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
