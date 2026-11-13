import { defineProject } from "vitest/config";

export const workspaceProjects = [
  defineProject({
    test: {
      name: "unit",
      include: [
        "packages/*/src/**/*.unit.test.ts",
        "apps/*/src/**/*.unit.test.ts",
        "apps/*/src/**/*.unit.test.tsx",
      ],
      exclude: ["**/node_modules/**", "**/dist/**"],
    },
  }),
  defineProject({
    test: {
      name: "integration",
      include: ["packages/*/src/**/*.integration.test.ts", "apps/*/src/**/*.integration.test.ts"],
      exclude: ["**/node_modules/**", "**/dist/**"],
      testTimeout: 180_000,
      hookTimeout: 180_000,
    },
  }),
];

export default workspaceProjects;
