import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Synthetic UI only: no API proxy, session or production settings.
export default defineConfig({
  plugins: [react()],
  server: { host: 'localhost', port: 5174, strictPort: true, open: '/?prototype=diary&variant=A' },
})
