import type { Config } from 'jest';

const shared: Pick<Config, 'testEnvironment' | 'collectCoverageFrom' | 'coverageDirectory' | 'moduleNameMapper'> = {
  testEnvironment: 'node',
  collectCoverageFrom: ['src/**/*.ts', '!src/cli.ts'],
  coverageDirectory: 'coverage',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};

const config: Config = {
  projects: [
    {
      ...shared,
      displayName: 'unit',
      preset: 'ts-jest',
      roots: ['<rootDir>/tests'],
      testMatch: ['**/*.test.ts'],
      testPathIgnorePatterns: [
        '<rootDir>/tests/eval/unit/eval_fixture_utils.test.ts',
      ],
    },
    {
      ...shared,
      displayName: 'eval-fixture-utils',
      preset: 'ts-jest/presets/default-esm',
      roots: ['<rootDir>/tests/eval/unit'],
      testMatch: ['**/eval_fixture_utils.test.ts'],
      extensionsToTreatAsEsm: ['.ts'],
      transform: {
        '^.+\\.tsx?$': [
          'ts-jest',
          {
            useESM: true,
            tsconfig: {
              module: 'ESNext',
              moduleResolution: 'node',
              esModuleInterop: true,
              allowJs: true,
              isolatedModules: true,
            },
          },
        ],
      },
    },
  ],
};

export default config;
