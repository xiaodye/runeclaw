import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelMessage } from 'ai';
import { TokenTracker } from './defense.js';
import { textToolResultOutput } from './tool-result-output.js';

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
