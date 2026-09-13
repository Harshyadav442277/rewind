import { defineConfig } from 'vite';

// `npm run dev -- --host` binds 0.0.0.0 so the phone on the same Wi-Fi can load the page.
export default defineConfig({
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022' },
});
