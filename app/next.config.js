/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['lunar-javascript'],
  // 子路径部署：Caddy 把 /ziwei/* 原样转发（不剥前缀），Next 自己带 basePath。
  basePath: '/ziwei',
  assetPrefix: '/ziwei',
};

module.exports = nextConfig;
