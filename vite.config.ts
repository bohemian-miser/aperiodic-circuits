import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base` matches the GitHub Pages project URL: bohemian-miser.github.io/aperiodic-circuits/
export default defineConfig({
  base: '/aperiodic-circuits/',
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
