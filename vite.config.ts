import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { devApiPlugin } from './dev-server/dev-api-plugin';

// The `api/` folder is deployed as Vercel serverless functions in production.
// `vite dev` does not know about them, so devApiPlugin mounts the very same handler
// modules in-process. Nothing about the deployment depends on the plugin.
export default defineConfig({
  plugins: [react(), devApiPlugin()],
  server: {
    host: true,
    port: 5173,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2020',
  },
});
