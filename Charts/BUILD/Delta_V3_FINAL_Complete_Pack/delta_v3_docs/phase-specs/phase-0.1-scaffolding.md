# Phase 0.1: Project Scaffolding

## Objective
Set up TypeScript monorepo structure for Delta Chart V3.

## Create Project Structure

```
delta-chart/
├── package.json              # Root package.json with workspaces
├── pnpm-workspace.yaml       # pnpm workspace config
├── tsconfig.json             # Base TypeScript config
├── tsconfig.build.json       # Build-specific config
├── vitest.config.ts          # Test configuration
├── .eslintrc.cjs             # ESLint config
├── .prettierrc               # Prettier config
├── packages/
│   ├── core/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       └── index.ts
│   ├── transport/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       └── index.ts
│   ├── data/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       └── index.ts
│   ├── render/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       └── index.ts
│   ├── webgpu/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       └── index.ts
│   ├── indicators/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       └── index.ts
│   ├── drawings/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       └── index.ts
│   ├── interaction/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       └── index.ts
│   └── chart/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           └── index.ts
└── apps/
    └── demo/
        ├── package.json
        ├── index.html
        ├── vite.config.ts
        └── src/
            └── main.ts
```

## Root package.json
```json
{
  "name": "delta-chart-monorepo",
  "private": true,
  "scripts": {
    "build": "pnpm -r build",
    "dev": "pnpm -r --parallel dev",
    "test": "vitest",
    "lint": "eslint packages/*/src/**/*.ts",
    "format": "prettier --write ."
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.3.0",
    "vitest": "^1.0.0",
    "eslint": "^8.56.0",
    "@typescript-eslint/eslint-plugin": "^6.0.0",
    "@typescript-eslint/parser": "^6.0.0",
    "prettier": "^3.0.0"
  }
}
```

## pnpm-workspace.yaml
```yaml
packages:
  - 'packages/*'
  - 'apps/*'
```

## Base tsconfig.json
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noUncheckedIndexedAccess": true,
    "noEmitOnError": true
  }
}
```

## Package naming convention
All packages use scope: `@anthropic/delta-chart-{name}`

Example package.json for core:
```json
{
  "name": "@anthropic/delta-chart-core",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "dev": "tsc -p tsconfig.build.json --watch"
  },
  "devDependencies": {
    "typescript": "^5.3.0"
  }
}
```

## Demo app (Vite)
```json
{
  "name": "delta-chart-demo",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  },
  "dependencies": {
    "@anthropic/delta-chart-webgpu": "workspace:*",
    "@anthropic/delta-chart-core": "workspace:*"
  },
  "devDependencies": {
    "vite": "^5.0.0"
  }
}
```

## Definition of Done
- [ ] `pnpm install` completes without errors
- [ ] `pnpm build` compiles all packages
- [ ] `pnpm test` runs (even if no tests yet)
- [ ] Each package exports from index.ts
- [ ] Demo app starts with `pnpm --filter demo dev`
