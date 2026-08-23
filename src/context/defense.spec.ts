import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelMessage } from 'ai';
import { TokenTracker, ttlPrune } from './defense.js';
import { textToolResultOutput, toolResultOutputToText } from './tool-result-output.js';

/** 构造一条带工具调用的助手消息，代表一个轮次的起点。 */
function assistantToolCallMsg(toolCallId: string, toolName: string): ModelMessage {
    return {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId, toolName, input: {} }],
    };
}

/** 构造一条工具结果消息。 */
function toolResultMsg(toolCallId: string, toolName: string, text: string): ModelMessage {
    return {
        role: 'tool',
        content: [
            { type: 'tool-result', toolCallId, toolName, output: textToolResultOutput(text) },
        ],
    };
}

/** 提取工具结果消息的输出文本，便于断言。 */
function outputText(msg: ModelMessage): string {
    return (msg.content as any[])
        .map((p) => (p.output ? toolResultOutputToText(p.output) : ''))
        .join('');
}

test('TokenTracker combines an API baseline with new structured messages', () => {
    const tracker = new TokenTracker();
    tracker.updateFromAPI(1_000);

    const messages: ModelMessage[] = [
        { role: 'user', content: '12345678' },
        {
            role: 'tool',
            content: [
                {
                    type: 'tool-result',
                    toolCallId: 'call-1',
                    toolName: 'read_file',
                    output: textToolResultOutput('abcdefgh'),
                },
            ],
        },
    ];

    tracker.addMessages(messages);

    assert.equal(tracker.estimatedTokens, 1_004);
});

test('TokenTracker keeps its precise baseline when defense replaces content', () => {
    const tracker = new TokenTracker();
    tracker.updateFromAPI(1_000);

    const before: ModelMessage[] = [{ role: 'user', content: '12345678' }];
    const after: ModelMessage[] = [{ role: 'user', content: '1234' }];
    tracker.replaceMessages(before, after);

    assert.equal(tracker.estimatedTokens, 999);
});

test('ttlPrune never prunes the most recent tool results', () => {
    const messages: ModelMessage[] = [
        { role: 'user', content: 'start' },
        assistantToolCallMsg('call-1', 'read_file'), // 轮次 1
        toolResultMsg('call-1', 'read_file', 'OLD_RESULT'),
        assistantToolCallMsg('call-2', 'read_file'), // 轮次 2（最近）
        toolResultMsg('call-2', 'read_file', 'RECENT_RESULT'),
    ];

    const now = Date.now();
    const timestamps = new Map<number, number>([
        [2, now - 11 * 60 * 1000], // 旧结果，墙钟已过期
        [4, now - 11 * 60 * 1000], // 最近结果，但墙钟同样过期
    ]);

    const result = ttlPrune(messages, timestamps, {
        softTTLMs: 5 * 60 * 1000,
        hardTTLMs: 10 * 60 * 1000,
        keepHeadTail: 1500,
        keepRecentToolResults: 1,
    });

    assert.equal(result.hardPruned, 1);
    assert.match(outputText(result.messages[2]), /tool result expired/);
    assert.equal(outputText(result.messages[4]), 'RECENT_RESULT');
});
