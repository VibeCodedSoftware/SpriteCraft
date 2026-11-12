import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { craftApi } from '../Shared/devserver/projectApi';

const here = __dirname;
const app = path.resolve(here, '..');

export default defineConfig({
  // The desktop build embeds these files, so paths stay relative.
  base: './',
  plugins: [
    react(),
    craftApi({
      app: 'spritecraft',
      projectsDir: path.join(here, 'projects'),
      exchangeDir: path.join(app, 'Shared', 'exchange'),
    }),
  ],
  resolve: {
    alias: {
      '@shared': path.join(app, 'Shared'),
      react: path.join(here, 'node_modules/react'),
      'react-dom': path.join(here, 'node_modules/react-dom'),
    },
  },
  server: { fs: { allow: [app] }, port: 5177 },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
} as any);
