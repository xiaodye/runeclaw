// @ts-check

import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default defineConfig(
    {
        ignores: [
            'dist/**',
            'node_modules/**',
            'build-web/**',
            '.sessions/**',
            '.memory/**',
            '.cron/**',
            '.usage/**',
            'knowledge.db',
        ],
    },
    {
        files: ['**/*.{js,mjs,cjs}'],
        extends: [eslint.configs.recommended],
        languageOptions: {
            globals: {
                URL: 'readonly',
                console: 'readonly',
                process: 'readonly',
            },
        },
        rules: {
            'no-console': 'off',
        },
    },
    {
        files: ['src/**/*.{ts,tsx}'],
        extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': [
                'warn',
                {
                    argsIgnorePattern: '^_',
                    caughtErrors: 'none',
                    varsIgnorePattern: '^_',
                },
            ],
            '@typescript-eslint/no-this-alias': 'off',
            'no-irregular-whitespace': 'off',
            'no-console': 'off',
            'no-useless-assignment': 'off',
            'prefer-const': 'off',
        },
    },
    prettier,
);
