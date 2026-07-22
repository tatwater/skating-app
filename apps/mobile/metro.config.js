// Monorepo-aware Metro config (D39). Even with pnpm's hoisted linker (root .npmrc),
// Metro must watch the workspace root and know both node_modules roots so it resolves
// hoisted deps and the local `@skating/*` workspace packages.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;
