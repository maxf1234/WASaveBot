import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// In development the site and the worker run separately. Proxying the worker's
// routes makes them the same origin anyway, exactly as in production, so there
// is no second way for the app to find its API.
// The worker's local port: `npm run dev` in worker/ listens here.
const worker = 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': worker,
      '/config.js': worker,
      '/health': worker,
    },
  },
});
