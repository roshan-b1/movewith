/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// All compute is client-side (webcam never leaves the device). No SSR.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true, // expose on LAN so you can test from a phone on the same network
  },
  // MediaPipe ships large wasm/model assets; don't inline them.
  build: {
    assetsInlineLimit: 0,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
