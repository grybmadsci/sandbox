import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // three + rapier (inlined WASM) make a large bundle by nature
    chunkSizeWarningLimit: 4000,
  },
})
