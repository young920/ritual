// @ts-check
import { defineConfig } from 'astro/config';

// GitHub Pages:young920.github.io/ritual/(repo name = ritual)
// base 必须配 /ritual 才能让 /screenshots/plan.png 等静态资源解析对。
export default defineConfig({
  site: 'https://young920.github.io',
  base: '/ritual',
  build: {
    assets: '_astro',
  },
});