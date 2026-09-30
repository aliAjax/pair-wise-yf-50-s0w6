export default defineNuxtConfig({
  devtools: { enabled: false },
  compatibilityDate: "2025-07-15",
  modules: ["@pinia/nuxt", "@vueuse/nuxt", "@nuxtjs/i18n"],
  // 离线应用依赖 localStorage / crypto 等客户端 API，整页客户端渲染，规避 naive-ui 的 css-render SSR 限制
  ssr: false,
  // naive-ui 依赖为 CommonJS，SSR 下需转译，否则命名导出（如 VResizeObserver）报错
  build: { transpile: ["naive-ui", "vueuc"] },
  css: ["~/assets/main.css"],
  i18n: {
    locales: [{ code: "zh", language: "zh-CN", name: "中文", file: "zh.json" }],
    defaultLocale: "zh",
    strategy: "no_prefix",
    langDir: "locales",
    bundle: { optimizeTranslationDirective: false }
  },
  app: {
    head: {
      title: "灾后需求评估与任务分派",
      meta: [{ name: "viewport", content: "width=device-width, initial-scale=1" }]
    }
  }
});
