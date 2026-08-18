import type { ToolResultPart } from 'ai';

/** AI SDK 工具结果支持的结构化输出联合类型。 */
export type ToolResultOutput = ToolResultPart['output'];

/**
 * 将纯文本包装为 AI SDK 可接受的工具结果输出。
 *
 * @param value 待包装的文本内容。
 * @returns 文本类型的工具结果输出。
 */
export function textToolResultOutput(value: string): ToolResultOutput {
    return { type: 'text', value };
}

/**
 * 将不同形态的工具结果统一转换为可读文本。
 *
 * @param output 待转换的工具结果输出。
 * @returns 适合拼接到上下文中的文本内容。
 */
export function toolResultOutputToText(output: ToolResultOutput): string {
    switch (output.type) {
        case 'text':
        case 'error-text':
            return output.value;
        case 'json':
        case 'error-json':
            return JSON.stringify(output.value);
        case 'content':
            return output.value
                .map((part) => (part.type === 'text' ? part.text : `[media: ${part.type}]`))
                .join('\n');
        default:
            return '';
    }
}
