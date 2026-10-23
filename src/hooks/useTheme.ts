import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

/**
 * 获取初始主题
 * 优先从 DOM 上读取父窗口可能已设置的主题，避免闪烁
 */
function getInitialTheme(): Theme {
  if (typeof document === 'undefined') return 'light';

  // 检查 document.documentElement 上是否已有主题类或属性
  const dataTheme = document.documentElement.getAttribute('data-theme');
  if (dataTheme === 'dark' || dataTheme === 'light') {
    return dataTheme;
  }

  // 检查类名
  if (document.documentElement.classList.contains('dark')) {
    return 'dark';
  }
  if (document.documentElement.classList.contains('light')) {
    return 'light';
  }

  // 默认 light
  return 'light';
}

/**
 * 监听父窗口的主题切换消息
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    // 监听来自父窗口的主题切换消息
    const handleMessage = (event: MessageEvent) => {
      // 安全性检查：可根据需要验证 event.origin
      if (event.data && typeof event.data.theme === 'string') {
        const newTheme = event.data.theme as Theme;
        if (newTheme === 'light' || newTheme === 'dark') {
          setTheme(newTheme);
          // 应用主题到DOM
          applyTheme(newTheme);
        }
      }
    };

    window.addEventListener('message', handleMessage);

    // 初始化时应用当前主题到DOM（确保首次渲染正确）
    const initialTheme = getInitialTheme();
    applyTheme(initialTheme);

    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, []);

  return theme;
}

/**
 * 应用主题到DOM
 */
function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return;

  // 移除旧的主题类
  document.documentElement.classList.remove('light', 'dark');
  // 添加新的主题类
  document.documentElement.classList.add(theme);
  // 设置data-theme属性
  document.documentElement.setAttribute('data-theme', theme);
}
