import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

// 配置 marked 使用终端渲染器（标题加粗、代码高亮、列表/表格着色等）
marked.use(markedTerminal());

/**
 * 把 markdown 一次性渲染为带 ANSI 样式的终端字符串。
 *
 * @param text markdown 源码。
 * @returns
 */
export function renderMarkdown(text: string): string {
    try {
        const result = marked.parse(text);
        return typeof result === 'string' ? result : String(result);
    } catch {
        // 解析失败回落到原样输出，避免中断流式展示
        return text;
    }
}
