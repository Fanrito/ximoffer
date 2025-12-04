/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html"], // 精准扫描当前目录的index.html
  theme: {
    extend: {
      colors: {
        primary: '#165DFF',
        secondary: '#36CFC9',
        dark: '#1D2129',
        light: '#F2F3F5',
        muted: '#86909C',
        live: '#F53F3F',
        upcoming: '#165DFF',
        ended: '#86909C'
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    }
  },
  plugins: [],
}