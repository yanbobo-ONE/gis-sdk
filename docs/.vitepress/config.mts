import { defineConfig } from 'vitepress';

export default defineConfig({
  lang: 'zh-CN',
  title: 'gis-sdk',
  description: '框架无关、可扩展的 Cesium GIS SDK',
  appearance: 'dark',
  cleanUrls: true,
  srcExclude: [
    'superpowers/**',
    'research/**',
    'api-readme.md',
    'cesium-sdk-prd.md',
    'publishing.md',
  ],
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: '快速开始', link: '/guide/getting-started' },
      { text: 'API 使用', link: '/guide/api-reference' },
      { text: '功能状态', link: '/guide/capability-status' },
      { text: '类型索引', link: '/api/' },
      { text: '变更日志', link: '/changelog' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: '开始',
          items: [
            { text: '快速开始', link: '/guide/getting-started' },
            { text: '导入与包体积', link: '/guide/imports' },
            { text: '功能状态与路线图', link: '/guide/capability-status' },
          ],
        },
        {
          text: '核心能力',
          items: [
            { text: 'API 使用参考', link: '/guide/api-reference' },
            { text: '图层管理', link: '/guide/layers' },
          ],
        },
        {
          text: '参考',
          items: [
            { text: 'TypeScript 类型索引', link: '/api/' },
            { text: '变更日志', link: '/changelog' },
          ],
        },
      ],
      '/': [
        {
          text: 'gis-sdk',
          items: [
            { text: '概览', link: '/' },
            { text: '快速开始', link: '/guide/getting-started' },
            { text: 'API 使用参考', link: '/guide/api-reference' },
            { text: '功能状态与路线图', link: '/guide/capability-status' },
            { text: '图层管理', link: '/guide/layers' },
            { text: 'TypeScript 类型索引', link: '/api/' },
          ],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/yanbobo-ONE/gis-sdk' }],
    search: { provider: 'local' },
    outline: { level: [2, 3], label: '本页内容' },
    docFooter: { prev: '上一页', next: '下一页' },
    lastUpdated: { text: '最后更新' },
  },
});
