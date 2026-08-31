import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#2CA01C',
          dark: '#108000',
          darker: '#0D6B00',
        },
        nav: {
          DEFAULT: '#393A3D',
          hover: '#4A4B50',
          active: '#2CA01C',
        },
        ink: {
          DEFAULT: '#393A3D',
          muted: '#6B6C72',
          light: '#8D9096',
        },
        line: '#D4D7DC',
        surface: '#F4F5F8',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'Segoe UI', 'Helvetica', 'Arial', 'sans-serif'],
      },
      fontSize: {
        xxs: ['11px', '14px'],
      },
    },
  },
  plugins: [],
};

export default config;
