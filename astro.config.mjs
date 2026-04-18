import { defineConfig } from 'astro/config';

const normalizeBase = (value = '/') => {
  if (!value || value === '/') {
    return '/';
  }

  return `/${value.replace(/^\/+|\/+$/g, '')}`;
};

export default defineConfig({
  output: 'static',
  site: process.env.SITE_URL || 'https://example.github.io',
  base: normalizeBase(process.env.BASE_PATH || '/'),
});
