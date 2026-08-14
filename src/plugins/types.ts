import type { ToolDefinition } from '../tools/registry';

export interface PluginConfig {
    /** 插件配置键值；值会在加载时解析环境变量占位符。 */
    [key: string]: string | number | boolean;
}

export interface PluginApi {
    /**
     * 注册插件暴露的工具定义。
     *
     * @param tools 待注册的工具列表。
     */
    registerTools(tools: ToolDefinition[]): void;
    /**
     * 获取插件加载后解析完成的配置。
     *
     * @returns
     */
    getConfig(): PluginConfig;
    /**
     * 输出插件作用域内的日志消息。
     *
     * @param message 日志消息。
     */
    log(message: string): void;
}

export interface PluginDefinition {
    /** 插件唯一名称，用于工具名前缀和加载去重。 */
    name: string;
    /** 插件版本号，用于展示和兼容性判断。 */
    version: string;
    /** 插件能力说明，会展示给用户或调试界面。 */
    description: string;
    /** 默认配置，可包含环境变量占位符。 */
    config?: PluginConfig;

    /**
     * 插件激活入口，在其中注册工具并初始化资源。
     *
     * @param api 插件运行时接口。
     */
    activate(api: PluginApi): Promise<void> | void;
    /**
     * 可选销毁钩子，用于卸载时释放资源。
     */
    destroy?(): Promise<void> | void;
}
