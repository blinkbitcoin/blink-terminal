/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class', // Enable dark mode with class strategy
  theme: {
    extend: {
      colors: {
        'blink-orange': '#FF6600',
        'blink-accent': '#FFAD0D',
        'blink-dark': '#1D1D1D',
        'blink-black': '#000000',
        // Main-app keypad design tokens (blink-mobile colors.ts; issue #44)
        'blink-primary': '#FC5805', // primary orange — light-mode C/backspace + accent
        success: '#00A700', // OK key border + text
        // Blink Classic theme colors (from Figma)
        // BC Dark
        'blink-classic-border': '#393939',
        'blink-classic-bg': '#1D1D1D',
        'blink-classic-text': '#FFFFFF',
        'blink-classic-amber': '#FFAD0D',
        // BC Light
        'blink-classic-border-light': '#E2E2E4',
        'blink-classic-hover-light': '#F2F2F4',
      },
      animation: {
        'payment-pulse': 'payment-pulse 0.6s ease-in-out',
        'payment-celebration': 'payment-celebration 4s ease-in-out',
      },
      keyframes: {
        'payment-pulse': {
          '0%, 100%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(1.05)' },
        },
        'payment-celebration': {
          '0%': { opacity: '0', transform: 'scale(0.1)' },
          '15%': { opacity: '1', transform: 'scale(1.2)' },
          '85%': { opacity: '1', transform: 'scale(1)' },
          '100%': { opacity: '0', transform: 'scale(1)' },
        },
      },
    },
  },
  plugins: [],
}
