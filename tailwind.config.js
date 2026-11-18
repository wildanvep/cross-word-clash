/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: "#eee3cb",
        ink: "#29251f",
        burgundy: "#782f3b",
        forest: "#344b3b",
      },
      fontFamily: {
        display: ["'Playfair Display'", "Georgia", "serif"],
        typewriter: ["'Special Elite'", "Courier New", "monospace"],
      },
    },
  },
  plugins: [],
};
