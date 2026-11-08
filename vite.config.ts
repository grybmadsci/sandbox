import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the build works under any subpath (e.g. GitHub Pages /sandbox/)
  base: './',
  build: {
    // three + rapier (inlined WASM) make a large bundle by nature
    chunkSizeWarningLimit: 4000,
  },
})
