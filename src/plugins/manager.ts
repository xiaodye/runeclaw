import type { ToolRegistry, ToolDefinition } from '../tools/registry';
import type { PluginDefinition, PluginConfig, PluginApi } from './types';

interface LoadedPlugin {
    /** 插件定义对象，包含生命周期和元信息。 */
    definition: PluginDefinition;
    /** 当前插件已注册到工具注册表的带前缀工具名。 */
    tools: string[];
}

export class PluginManager {
    /** 已加载插件表，以插件名索引。 */
    private plugins = new Map<string, LoadedPlugin>();
    /** 全局工具注册表，插件工具会注册到这里。 */
    private registry: ToolRegistry;

    /**
     * 创建插件管理器并绑定工具注册表。
     *
     * @param registry 用于注册和注销插件工具的工具注册表。
     */
    constructor(registry: ToolRegistry) {
        this.registry = registry;
    }

    /**
     * 激活插件、解析配置并注册其声明的工具。
     *
     * @param definition 插件定义，插件名必须未加载。
     * @param config 运行时覆盖配置，会与插件默认配置合并。
     * @returns
     */
    async load(definition: PluginDefinition, config?: PluginConfig): Promise<string[]> {
        if (this.plugins.has(definition.name)) {
            throw new Error(`插件 "${definition.name}" 已加载`);
        }

        const resolvedConfig = this.resolveEnvVars({
            ...definition.config,
            ...config,
        });

        const registeredTools: string[] = [];

        const api: PluginApi = {
            /**
             * 注册插件提供的工具，并为工具名加上插件名前缀避免冲突。
             *
             * @param tools 插件要暴露的工具定义列表。
             */
            registerTools: (tools: ToolDefinition[]) => {
                for (const tool of tools) {
                    const prefixedName = `${definition.name}__${tool.name}`;
                    const prefixedTool: ToolDefinition = {
                        ...tool,
                        name: prefixedName,
                        description: `[Plugin:${definition.name}] ${tool.description}`,
                    };
                    this.registry.register(prefixedTool);
                    registeredTools.push(prefixedName);
                }
            },
            /**
             * 返回已解析环境变量后的插件配置。
             *
             * @returns
             */
            getConfig: () => resolvedConfig,
            /**
             * 输出带插件名前缀的运行日志。
             *
             * @param message 日志消息。
             */
            log: (message: string) => {
                console.log(`  [plugin:${definition.name}] ${message}`);
            },
        };

        try {
            await definition.activate(api);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`  [plugin:${definition.name}] 激活失败: ${msg}`);
            throw err;
        }

        this.plugins.set(definition.name, {
            definition,
            tools: registeredTools,
        });

        return registeredTools;
    }

    /**
     * 卸载指定插件，调用销毁钩子并注销它注册过的工具。
     *
     * @param name 要卸载的插件名。
     * @returns
     */
    async unload(name: string): Promise<boolean> {
        const plugin = this.plugins.get(name);
        if (!plugin) return false;

        if (plugin.definition.destroy) {
            try {
                await plugin.definition.destroy();
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`  [plugin:${name}] destroy 出错: ${msg}`);
            }
        }

        for (const toolName of plugin.tools) {
            this.registry.unregister(toolName);
        }

        this.plugins.delete(name);
        return true;
    }

    /**
     * 按当前加载顺序卸载所有插件。
     */
    async unloadAll(): Promise<void> {
        const names = Array.from(this.plugins.keys());
        for (const name of names) {
            await this.unload(name);
        }
    }

    /**
     * 读取已加载插件的内部状态。
     *
     * @param name 插件名。
     * @returns
     */
    get(name: string): LoadedPlugin | undefined {
        return this.plugins.get(name);
    }

    /**
     * 列出已加载插件的展示信息和已注册工具。
     *
     * @returns
     */
    list(): Array<{
        /** 插件名称。 */
        name: string;
        /** 插件版本号。 */
        version: string;
        /** 插件能力描述。 */
        description: string;
        /** 插件已注册工具名列表。 */
        tools: string[];
    }> {
        return Array.from(this.plugins.values()).map((p) => ({
            name: p.definition.name,
            version: p.definition.version,
            description: p.definition.description,
            tools: p.tools,
        }));
    }

    /**
     * 将形如 `${ENV_NAME}` 的配置值替换为当前进程环境变量。
     *
     * @param config 插件默认配置与运行时配置的合并结果。
     * @returns
     */
    private resolveEnvVars(config: PluginConfig): PluginConfig {
        const resolved: PluginConfig = {};
        for (const [key, value] of Object.entries(config)) {
            if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
                const envKey = value.slice(2, -1);
                resolved[key] = process.env[envKey] || '';
            } else {
                resolved[key] = value;
            }
        }
        return resolved;
    }
}
