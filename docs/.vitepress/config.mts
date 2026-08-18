import { defineConfig } from 'vitepress';

export default defineConfig({
  lang: 'zh-CN',
  title: 'gis-sdk',
  description: '框架无关、可扩展的 Cesium GIS SDK',
  srcExclude: ['superpowers/**', 'api-readme.md'],
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: '指南', link: '/guide/getting-started' },
      { text: 'API', link: '/api/' },
      { text: 'PRD', link: '/cesium-sdk-prd' },
      { text: '发布', link: '/publishing' },
      { text: 'Changelog', link: '/changelog' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: '接入指南',
          items: [{ text: '快速开始', link: '/guide/getting-started' }],
        },
      ],
      '/': [
        {
          text: '项目文档',
          items: [
            { text: '概览', link: '/' },
            { text: '公开接口', link: '/api' },
            { text: '产品需求文档', link: '/cesium-sdk-prd' },
            { text: '参考调研', link: '/research/cesium-sdk-reference-research' },
            { text: 'npm 发布', link: '/publishing' },
            { text: '变更日志', link: '/changelog' },
          ],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/yanbobo-ONE/gis-sdk' }],
    search: { provider: 'local' },
    outline: { level: [2, 3] },
    docFooter: { prev: '上一页', next: '下一页' },
    lastUpdated: { text: '最后更新' },
  },
});
