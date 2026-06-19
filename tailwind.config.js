/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // "Midnight studio" — warm-tinted near-black with layered surfaces.
        ink: '#0a0a0f',
        ink2: '#0d0d14',
        panel: '#15151f',
        panel2: '#1c1c28',
        line: 'rgba(255,255,255,0.08)',
        brand: '#8b6cff',
        brand2: '#ff6aa2',
        good: '#3ddc97',
        bad: '#ff6b6b',
        warn: '#ffb84d',
      },
      fontFamily: {
        sans: ['Satoshi', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
        display: ['"Clash Display"', 'Satoshi', 'system-ui', 'sans-serif'],
      },
      letterSpacing: {
        tightish: '-0.015em',
      },
      borderRadius: {
        '2.5xl': '1.25rem',
      },
      boxShadow: {
        soft: '0 1px 0 0 rgba(255,255,255,0.04) inset, 0 10px 30px -12px rgba(0,0,0,0.6)',
        glow: '0 10px 40px -10px rgba(139,108,255,0.45)',
        glowpink: '0 10px 40px -12px rgba(255,106,162,0.4)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.5s cubic-bezier(0.22,1,0.36,1) both',
      },
    },
  },
  plugins: [],
}
