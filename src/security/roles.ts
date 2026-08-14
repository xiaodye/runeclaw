export type Role = 'owner' | 'collaborator' | 'guest';

export interface UserIdentity {
    /** 用户唯一标识，用于权限判断和审计关联。 */
    id: string;
    /** 用户显示名称。 */
    name: string;
    /** 用户在当前会话中的权限角色。 */
    role: Role;
}

const TOOL_ACCESS: Record<
    Role,
    {
        /** 允许访问的工具名列表，`*` 表示全部允许。 */
        allow: string[] | '*';
        /** 即使 allow 命中也需要拒绝的工具名列表。 */
        deny: string[];
    }
> = {
    owner: {
        allow: '*',
        deny: [],
    },
    collaborator: {
        allow: '*',
        deny: ['bash'],
    },
    guest: {
        allow: [
            'get_weather',
            'calculator',
            'read_file',
            'list_directory',
            'glob',
            'grep',
            'rag_search',
        ],
        deny: [],
    },
};

/**
 * 判断指定角色是否可使用某个工具。
 *
 * @param role 用户角色。
 * @param toolName 待检查的工具名。
 * @returns
 */
export function canUseTool(role: Role, toolName: string): boolean {
    const access = TOOL_ACCESS[role];
    if (access.deny.includes(toolName)) return false;
    if (access.allow === '*') return true;
    return access.allow.includes(toolName);
}

/**
 * 按角色权限过滤工具列表。
 *
 * @param toolNames 候选工具名列表。
 * @param role 用户角色。
 * @returns
 */
export function filterToolsForRole(toolNames: string[], role: Role): string[] {
    return toolNames.filter((name) => canUseTool(role, name));
}
