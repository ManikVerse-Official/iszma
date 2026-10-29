/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'neon-purple': '#8b5cf6',
        'bg-dark-start': '#0A0612',
        'bg-dark-end': '#1a0b2e',
      },
      boxShadow: {
        'neon': '0 0 10px #8b5cf6, 0 0 20px #8b5cf6',
      }
    },
  },
  plugins: [],
}
