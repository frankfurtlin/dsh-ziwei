import type { Metadata } from 'next';
import './globals.css';
import { ThemeProvider } from '@/components/ThemeProvider';

export const metadata: Metadata = {
  title: '紫微斗数',
  description: '在 DSH 里排盘、看古籍、查知识库；解读由 DSH 的模型现场生成。',
  // 这个应用只在内嵌环境里用，不需要 canonical / sitemap / 搜索引擎验证
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `(function(){try{var q=new URLSearchParams(location.search).get('theme');if(q!=='light'&&q!=='dark')q=null;var t=q||localStorage.getItem('ziwei-theme');document.documentElement.setAttribute('data-theme',(t==='light'||t==='dark')?t:'light');}catch(e){document.documentElement.setAttribute('data-theme','light');}})();` }} />
      </head>
      <body className="min-h-screen">
        <ThemeProvider>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
