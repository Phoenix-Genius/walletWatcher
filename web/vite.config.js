import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // Pin the dev server to a known port and host to avoid localhost/IPv6 quirks on Windows
    port: 5177,
    strictPort: true,
    host: true, // listen on all addresses (0.0.0.0) so localhost/127.0.0.1 both work
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4000',
        changeOrigin: true,
        secure: false,
      }
    }
  }
})
