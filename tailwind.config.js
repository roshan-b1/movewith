/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Rhythm-game palette: deep night background, hot-pink primary, cyan secondary.
        // `ink` is the light FOREGROUND, `paper` the dark background (so the existing
        // ink/paper utility classes invert cleanly to a dark theme).
        paper: '#0b0b16',
        panel: '#16162a',
        panel2: '#1e1e38',
        ink: '#f5f6ff',
        line: 'rgba(245,246,255,0.11)',
        brand: '#ff2e88',
        brand2: '#22d3ee',
        good: '#a3e635',
        bad: '#ff4d6d',
        warn: '#ff9f1c',
        cream: '#fff2f8',
      },
      fontFamily: {
        sans: ['Satoshi', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
        display: ['"Clash Display"', 'Satoshi', 'system-ui', 'sans-serif'],
      },
      letterSpacing: { tightish: '-0.015em' },
      borderRadius: { '2.5xl': '1.25rem' },
      boxShadow: {
        soft: '0 1px 0 0 rgba(255,255,255,0.05) inset, 0 12px 30px -14px rgba(0,0,0,0.7)',
        glow: '0 10px 36px -10px rgba(255,46,136,0.5)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: { 'fade-up': 'fade-up 0.5s cubic-bezier(0.22,1,0.36,1) both' },
    },
  },
  plugins: [],
}
