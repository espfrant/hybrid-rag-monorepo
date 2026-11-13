import { defineConfig } from "vitest/config";
import workspaceProjects from "./vitest.workspace.js";

export default defineConfig({
  test: {
    projects: workspaceProjects,
  },
});
