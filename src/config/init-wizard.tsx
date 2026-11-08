import fs from 'node:fs';
import { useState, type ReactElement, type ReactNode } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import { CONFIG_FILE, ensureUserDir } from './paths';
import type { SuperAgentConfig } from './schema';

/** 表示「自定义模型名」这一选项的哨兵值，避免与真实模型名冲突。 */
const MODEL_CUSTOM = '__custom__';

/** 模型选择的候选项，value 会被写入 model.name，说明性文字折叠进 label 展示。 */
const MODEL_OPTIONS: Array<{ value: string; label: string }> = [
    { value: 'deepseek-v4-flash', label: 'deepseek-v4-flash   推荐 · 均衡' },
    { value: 'deepseek-v4-pro', label: 'deepseek-v4-pro   更强' },
    { value: MODEL_CUSTOM, label: '自定义模型名称' },
];

/** 向导收集到的全部答案，最终映射到配置。 */
interface Answers {
    /** 已解析的模型名，写入 model.name。 */
    model: string;
    /** 模型 API 的基础地址，写入 model.baseURL。 */
    baseURL: string;
    /** 模型 API Key，写入 model.apiKey。 */
    apiKey: string;
    /** 是否启用飞书 Channel。 */
    enableFeishu: boolean;
    /** 飞书应用 App ID。 */
    feishuAppId: string;
    /** 飞书应用 App Secret。 */
    feishuAppSecret: string;
    /** DashScope API Key，用于 RAG 向量化（embeddings）。 */
    dashscopeKey: string;
    /** 子 Agent 最大并发数，保留原始字符串以便编辑后统一校验。 */
    maxConcurrent: string;
}

/** 向导的各个阶段；done 为写入完成后的收尾界面。 */
type Phase =
    | 'overwrite'
    | 'model'
    | 'customModel'
    | 'baseUrl'
    | 'apiKey'
    | 'feishu'
    | 'feishuAppId'
    | 'feishuAppSecret'
    | 'dashscope'
    | 'concurrency'
    | 'review'
    | 'done';

/**
 * 按当前分支标志动态计算向导阶段的顺序（不含收尾的 done）。
 *
 * @param customModel 是否走自定义模型分支。
 * @param enableFeishu 是否启用飞书 Channel。
 * @param configExists 配置文件是否已存在，决定是否插入覆盖确认步骤。
 * @returns
 */
function phaseList(customModel: boolean, enableFeishu: boolean, configExists: boolean): Phase[] {
    const list: Phase[] = [];
    if (configExists) list.push('overwrite');
    list.push('model');
    if (customModel) list.push('customModel');
    list.push('baseUrl', 'apiKey', 'feishu');
    if (enableFeishu) list.push('feishuAppId', 'feishuAppSecret');
    list.push('dashscope', 'concurrency', 'review');
    return list;
}

/**
 * 根据当前阶段与分支标志，计算下一阶段。
 *
 * @param phase 当前阶段。
 * @param customModel 是否走自定义模型分支。
 * @param enableFeishu 是否启用飞书 Channel。
 * @returns
 */
function nextPhase(phase: Phase, customModel: boolean, enableFeishu: boolean): Phase {
    switch (phase) {
        case 'overwrite':
            return 'model';
        case 'model':
            return customModel ? 'customModel' : 'baseUrl';
        case 'customModel':
            return 'baseUrl';
        case 'baseUrl':
            return 'apiKey';
        case 'apiKey':
            return 'feishu';
        case 'feishu':
            return enableFeishu ? 'feishuAppId' : 'dashscope';
        case 'feishuAppId':
            return 'feishuAppSecret';
        case 'feishuAppSecret':
            return 'dashscope';
        case 'dashscope':
            return 'concurrency';
        case 'concurrency':
            return 'review';
        case 'review':
        case 'done':
            return 'done';
    }
}

/**
 * 依据答案生成面向 DeepSeek 的配置文件；所有设置直接保存到用户配置。
 *
 * @param answers 向导收集到的答案。
 * @returns
 */
function buildConfig(answers: Answers): SuperAgentConfig {
    return {
        version: '1.0',
        model: {
            provider: 'custom',
            name: answers.model,
            baseURL: answers.baseURL,
            apiKey: answers.apiKey,
        },
        search: { tavilyApiKey: '', serperApiKey: '' },
        plugins: [],
        mcp: { servers: {} },
        channels: {
            feishu: {
                enabled: answers.enableFeishu,
                appId: answers.feishuAppId,
                appSecret: answers.feishuAppSecret,
                port: 3000,
            },
        },
        agents: {
            maxSpawnDepth: 1,
            maxConcurrent: parseInt(answers.maxConcurrent, 10) || 3,
            defaultTimeout: 60000,
        },
        security: { defaultRole: 'developer', auditLog: true, bashTimestamp: true },
        memory: { dataDir: '.' },
        rag: { enabled: true, docsDir: 'docs', embeddingKey: answers.dashscopeKey },
        cron: { enabled: true, dataDir: '.' },
        session: { id: 'default' },
        usage: { trackingFile: 'usage/today.jsonl' },
    };
}

/**
 * 将答案写入用户目录的 config.json。
 *
 * @param answers 向导收集到的答案。
 * @returns
 */
function writeFiles(answers: Answers): void {
    ensureUserDir();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(buildConfig(answers), null, 2) + '\n', {
        mode: 0o600,
    });
}

/** 表单字段的外壳：渲染标签、可选说明以及下方内容区。 */
function FieldShell(props: {
    label: string;
    description?: string;
    children: ReactNode;
}): ReactElement {
    return (
        <Box flexDirection="column">
            <Text bold color="white">
                {props.label}
            </Text>
            {props.description ? <Text dimColor>{props.description}</Text> : null}
            <Box marginTop={1}>{props.children}</Box>
        </Box>
    );
}

/** 单个文本输入字段，负责把按键转换为受控的 value。 */
function TextField(props: {
    label: string;
    description?: string;
    value: string;
    placeholder?: string;
    /** 是否默认隐藏输入内容（用于密钥），开启后可用 Tab 切换显隐。 */
    mask?: boolean;
    onChange: (value: string) => void;
    onSubmit: () => void;
}): ReactElement {
    const { value, onChange, onSubmit, label, description, placeholder, mask } = props;
    const [reveal, setReveal] = useState(!mask);

    useInput((input, key) => {
        if (key.return) {
            onSubmit();
            return;
        }
        if (key.tab && mask) {
            setReveal((s) => !s);
            return;
        }
        if (key.backspace || key.delete) {
            onChange(value.slice(0, -1));
            return;
        }
        // 忽略空输入与不可打印字符，避免方向键等控制序列被拼进 value。
        if (!input || input.split('').some((c) => c.charCodeAt(0) < 32)) return;
        onChange(value + input);
    });

    const display = mask && !reveal ? '•'.repeat(value.length) : value;

    return (
        <FieldShell label={label} description={description}>
            <Text color="cyan">❯ </Text>
            <Text color={display ? 'white' : 'gray'}>{display || placeholder || ''}</Text>
            <Text color="cyan" dimColor>
                ▌
            </Text>
            {mask ? <Text dimColor>　（输入已隐藏，Tab 切换显示）</Text> : null}
        </FieldShell>
    );
}

/** 布尔确认字段，支持 y/n 与回车使用默认值。 */
function ConfirmField(props: {
    label: string;
    description?: string;
    defaultValue: boolean;
    onSubmit: (value: boolean) => void;
}): ReactElement {
    const { label, description, defaultValue, onSubmit } = props;

    useInput((input, key) => {
        if (key.return) {
            onSubmit(defaultValue);
            return;
        }
        const ch = input.toLowerCase();
        if (ch === 'y') {
            onSubmit(true);
            return;
        }
        if (ch === 'n') {
            onSubmit(false);
            return;
        }
    });

    return (
        <FieldShell label={label} description={description}>
            <Text color="cyan">❯ </Text>
            <Text dimColor>{defaultValue ? '[Y/n]' : '[y/N]'}</Text>
        </FieldShell>
    );
}

/** 底部操作提示，随阶段类型给出不同按键说明。 */
function HintBar(props: { phase: Phase }): ReactElement {
    const { phase } = props;
    let hint = 'Enter 确认 · Ctrl+C 退出';
    if (phase === 'model') hint = '↑/↓ 选择 · 1-3 快捷 · Enter 确认 · Ctrl+C 退出';
    if (phase === 'overwrite' || phase === 'feishu' || phase === 'review') {
        hint = 'Y/N 选择 · Enter 使用默认 · Ctrl+C 退出';
    }
    return (
        <Text dimColor color="gray">
            {hint}
        </Text>
    );
}

/** 展示已填写内容的复核摘要，密钥只显示「已填写 / 留空」。 */
function ReviewList(props: { answers: Answers }): ReactElement {
    const { answers } = props;
    const rows: Array<[string, string]> = [
        ['模型', answers.model],
        ['API Base URL', answers.baseURL || '（默认 https://api.deepseek.com）'],
        ['LLM API Key', answers.apiKey ? '（已填写）' : '（留空，稍后在配置中填写）'],
        ['飞书 Channel', answers.enableFeishu ? '启用' : '关闭'],
        ...(answers.enableFeishu
            ? ([
                  ['飞书 App ID', answers.feishuAppId || '（留空）'],
                  ['飞书 App Secret', answers.feishuAppSecret ? '（已填写）' : '（留空）'],
              ] as Array<[string, string]>)
            : []),
        [
            'DashScope Key (向量化)',
            answers.dashscopeKey ? '（已填写）' : '（留空，RAG 工具不可用）',
        ],
        ['子 Agent 并发数', answers.maxConcurrent || '3'],
    ];
    return (
        <Box flexDirection="column">
            {rows.map(([k, v]) => (
                <Box key={k}>
                    <Box width={26}>
                        <Text color="gray">{k}</Text>
                    </Box>
                    <Text color="white">{v}</Text>
                </Box>
            ))}
        </Box>
    );
}

/** RuneClaw 初始化向导的主组件，维护阶段机与答案状态并渲染对应表单。 */
export function InitWizard(): ReactElement {
    const { exit } = useApp();
    const configExists = fs.existsSync(CONFIG_FILE);
    const [phase, setPhase] = useState<Phase>(configExists ? 'overwrite' : 'model');
    const [customModel, setCustomModel] = useState(false);
    const [answers, setAnswers] = useState<Answers>({
        model: '',
        baseURL: 'https://api.deepseek.com',
        apiKey: '',
        enableFeishu: false,
        feishuAppId: '',
        feishuAppSecret: '',
        dashscopeKey: '',
        maxConcurrent: '3',
    });

    /** 合并最新输入到答案，并依据最新分支标志推进到下一阶段。 */
    const commit = (patch: Partial<Answers>): void => {
        const merged = { ...answers, ...patch };
        setAnswers(merged);
        setPhase(nextPhase(phase, customModel, merged.enableFeishu));
    };

    // 收尾界面：按 Enter 或 Esc 结束向导。
    useInput((_input, key) => {
        if (phase === 'done' && (key.return || key.escape)) {
            exit();
        }
    });

    const phases = phaseList(customModel, answers.enableFeishu, configExists);
    const stepIndex = phases.indexOf(phase);
    const stepTotal = phases.length;
    const progressText = phase === 'done' ? '完成' : `步骤 ${stepIndex + 1}/${stepTotal}`;

    let body: ReactElement;

    switch (phase) {
        case 'overwrite':
            body = (
                <ConfirmField
                    label={`${CONFIG_FILE} 已存在，是否覆盖？`}
                    defaultValue={false}
                    onSubmit={(ok) => {
                        if (!ok) exit();
                        else setPhase('model');
                    }}
                />
            );
            break;
        case 'model':
            body = (
                <FieldShell label="选择 DeepSeek 模型">
                    <SelectInput
                        items={MODEL_OPTIONS}
                        onSelect={(item) => {
                            if (item.value === MODEL_CUSTOM) {
                                setCustomModel(true);
                                setAnswers((a) => ({ ...a, model: '' }));
                                setPhase('customModel');
                            } else {
                                commit({ model: item.value });
                            }
                        }}
                    />
                </FieldShell>
            );
            break;
        case 'customModel':
            body = (
                <TextField
                    label="自定义模型名称"
                    placeholder="deepseek-v4-flash"
                    value={answers.model}
                    onChange={(v) => setAnswers((a) => ({ ...a, model: v }))}
                    onSubmit={() => commit({})}
                />
            );
            break;
        case 'baseUrl':
            body = (
                <TextField
                    label="API Base URL"
                    description="模型服务的 OpenAI 兼容地址"
                    placeholder="https://api.deepseek.com"
                    value={answers.baseURL}
                    onChange={(v) => setAnswers((a) => ({ ...a, baseURL: v }))}
                    onSubmit={() => commit({})}
                />
            );
            break;
        case 'apiKey':
            body = (
                <TextField
                    label="LLM API Key"
                    description="直接保存到用户配置；留空可稍后填写"
                    placeholder="sk-..."
                    mask
                    value={answers.apiKey}
                    onChange={(v) => setAnswers((a) => ({ ...a, apiKey: v }))}
                    onSubmit={() => commit({})}
                />
            );
            break;
        case 'feishu':
            body = (
                <ConfirmField
                    label="启用飞书 Channel？"
                    description="用于通过飞书机器人收发 Agent 消息"
                    defaultValue={false}
                    onSubmit={(value) => commit({ enableFeishu: value })}
                />
            );
            break;
        case 'feishuAppId':
            body = (
                <TextField
                    label="飞书 App ID"
                    placeholder="cli_xxxxx"
                    value={answers.feishuAppId}
                    onChange={(v) => setAnswers((a) => ({ ...a, feishuAppId: v }))}
                    onSubmit={() => commit({})}
                />
            );
            break;
        case 'feishuAppSecret':
            body = (
                <TextField
                    label="飞书 App Secret"
                    mask
                    placeholder="xxxxx"
                    value={answers.feishuAppSecret}
                    onChange={(v) => setAnswers((a) => ({ ...a, feishuAppSecret: v }))}
                    onSubmit={() => commit({})}
                />
            );
            break;
        case 'dashscope':
            body = (
                <TextField
                    label="DashScope API Key（向量化）"
                    description="用于 RAG 的文本 embeddings；留空则不启用 RAG 工具"
                    placeholder="sk-..."
                    mask
                    value={answers.dashscopeKey}
                    onChange={(v) => setAnswers((a) => ({ ...a, dashscopeKey: v }))}
                    onSubmit={() => commit({})}
                />
            );
            break;
        case 'concurrency':
            body = (
                <TextField
                    label="子 Agent 最大并发数"
                    description="取值范围 1-10"
                    placeholder="3"
                    value={answers.maxConcurrent}
                    onChange={(v) =>
                        setAnswers((a) => ({ ...a, maxConcurrent: v.replace(/\D/g, '') }))
                    }
                    onSubmit={() => {
                        const n = parseInt(answers.maxConcurrent, 10);
                        const clamped = Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : 3;
                        setAnswers((a) => ({ ...a, maxConcurrent: String(clamped) }));
                        setPhase('review');
                    }}
                />
            );
            break;
        case 'review':
            body = (
                <Box flexDirection="column">
                    <ReviewList answers={answers} />
                    <Box marginTop={1}>
                        <ConfirmField
                            label="确认写入配置？"
                            defaultValue={true}
                            onSubmit={(ok) => {
                                if (!ok) {
                                    exit();
                                    return;
                                }
                                writeFiles(answers);
                                setPhase('done');
                            }}
                        />
                    </Box>
                </Box>
            );
            break;
        case 'done':
            body = (
                <Box flexDirection="column">
                    <Text color="green">✓ {CONFIG_FILE} 已生成</Text>
                    <Box marginTop={1}>
                        <Text>启动 Agent：</Text>
                        <Text bold color="cyan">
                            pnpm start
                        </Text>
                    </Box>
                </Box>
            );
            break;
    }

    return (
        <Box flexDirection="column" padding={1}>
            <Box>
                <Text bold color="cyan">
                    RuneClaw
                </Text>
                <Text bold> 初始化向导</Text>
            </Box>
            <Text dimColor>配置模型、RAG 向量化与 Channel，生成 ~/.runeclaw/config.json</Text>
            <Text dimColor>──────────────────────────────────────────────</Text>
            <Box marginTop={1} justifyContent="space-between">
                <Text color="yellow">{progressText}</Text>
            </Box>
            <Box marginTop={1}>{body}</Box>
            <Box marginTop={2}>
                <HintBar phase={phase} />
            </Box>
            {phase === 'done' ? (
                <Box marginTop={1}>
                    <Text dimColor>按 Enter 结束</Text>
                </Box>
            ) : null}
        </Box>
    );
}
