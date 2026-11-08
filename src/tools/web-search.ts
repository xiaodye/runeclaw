import type { ToolDefinition } from './registry.js';
import TurndownService from 'turndown';

// ── Tavily（自动挡）──────────────────────────────

/**
 * 创建使用指定密钥的 Tavily 工具。
 * @param apiKey 用户配置中的服务密钥。
 * @returns
 */
function createTavilySearchTool(apiKey: string): ToolDefinition {
    return {
        name: 'web_search',
        description: '搜索互联网获取最新信息。返回相关网页的标题、链接和内容摘要',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '搜索关键词' },
                max_results: { type: 'number', description: '返回结果数量，默认 5' },
            },
            required: ['query'],
        },
        isConcurrencySafe: true,
        isReadOnly: true,
        maxResultChars: 8000,
        execute: async ({ query, max_results = 5 }: { query: string; max_results?: number }) => {
            if (!apiKey)
                return '[web_search] 请在 ~/.runeclaw/config.json 中设置 search.tavilyApiKey';

            const res = await fetch('https://api.tavily.com/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    api_key: apiKey,
                    query,
                    max_results,
                    include_answer: true,
                }),
            });

            if (!res.ok) return `[web_search] 请求失败: HTTP ${res.status}`;

            const data = (await res.json()) as any;
            const lines: string[] = [];

            if (data.answer) {
                lines.push(`## AI 摘要\n${data.answer}\n`);
            }

            for (const r of data.results || []) {
                lines.push(`### ${r.title}`);
                lines.push(r.url);
                lines.push(r.content || r.snippet || '');
                lines.push('');
            }

            return lines.join('\n') || '没有找到相关结果';
        },
    };
}

// ── Serper（手动挡）──────────────────────────────

/**
 * 创建使用指定密钥的 Serper 工具。
 * @param apiKey 用户配置中的服务密钥。
 * @returns
 */
function createSerperSearchTool(apiKey: string): ToolDefinition {
    return {
        name: 'web_search',
        description: '搜索互联网获取最新信息。返回 Google 搜索结果的标题、链接和摘要',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '搜索关键词' },
                max_results: { type: 'number', description: '返回结果数量，默认 5' },
            },
            required: ['query'],
        },
        isConcurrencySafe: true,
        isReadOnly: true,
        maxResultChars: 8000,
        execute: async ({ query, max_results = 5 }: { query: string; max_results?: number }) => {
            if (!apiKey)
                return '[web_search] 请在 ~/.runeclaw/config.json 中设置 search.serperApiKey';

            const res = await fetch('https://google.serper.dev/search', {
                method: 'POST',
                headers: {
                    'X-API-KEY': apiKey,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ q: query, num: max_results }),
            });

            if (!res.ok) return `[web_search] 请求失败: HTTP ${res.status}`;

            const data = (await res.json()) as any;
            const lines: string[] = [];

            // Knowledge Graph（如果有）
            if (data.knowledgeGraph) {
                const kg = data.knowledgeGraph;
                lines.push(`## ${kg.title}`);
                if (kg.description) lines.push(kg.description);
                lines.push('');
            }

            // Organic Results
            for (const r of (data.organic || []).slice(0, max_results)) {
                lines.push(`### ${r.title}`);
                lines.push(r.link);
                lines.push(r.snippet || '');
                lines.push('');
            }

            return lines.join('\n') || '没有找到相关结果';
        },
    };
}

// ── Web Fetch（手动挡配套）──────────────────────────────

export const webFetchTool: ToolDefinition = {
    name: 'web_fetch',
    description:
        '抓取指定 URL 的网页内容，转换为 Markdown 格式。搭配 web_search 使用——先搜索拿到链接，再用这个工具读取详细内容',
    parameters: {
        type: 'object',
        properties: {
            url: { type: 'string', description: '完整 URL' },
        },
        required: ['url'],
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    maxResultChars: 16000, // 抓网页是大结果工具，保留更多上下文
    execute: async ({ url }: { url: string }) => {
        try {
            const res = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; SuperAgent/1.0)',
                    Accept: 'text/html,application/xhtml+xml',
                },
                signal: AbortSignal.timeout(15000),
            });

            if (!res.ok) return `抓取失败: HTTP ${res.status}`;

            const html = await res.text();
            return htmlToMarkdown(html);
        } catch (err: any) {
            return `抓取失败: ${err.message}`;
        }
    },
};

const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
});
turndown.remove(['script', 'style', 'nav', 'footer', 'header', 'iframe']);

function htmlToMarkdown(html: string): string {
    return turndown.turndown(html);
}

/**
 * 根据用户配置选择搜索后端，优先使用 Tavily。
 * @param config 搜索服务密钥。
 * @returns
 */
export function pickSearchTool(config: {
    /** Tavily 密钥。 */ tavilyApiKey: string;
    /** Serper 密钥。 */ serperApiKey: string;
}): ToolDefinition {
    if (config.tavilyApiKey) return createTavilySearchTool(config.tavilyApiKey);
    if (config.serperApiKey) return createSerperSearchTool(config.serperApiKey);
    return createTavilySearchTool('');
}
