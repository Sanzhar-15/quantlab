# Quantlab

A powerful code editor and development platform built on the foundation of VS Code.

## The Repository

This repository contains the source code for Quantlab. It is based on VS Code's open-source foundation with customizations for quantitative development workflows.

## Features

- Full-featured code editor with IntelliSense
- Integrated terminal
- Git integration
- Extensions via Open-VSX marketplace
- Customizable themes and settings

## Building from Source

### Prerequisites

- [Node.js](https://nodejs.org/) (see `.nvmrc` for recommended version)
- [Git](https://git-scm.com/)
- Platform-specific build tools

### Quick Start

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode for development
npm run watch

# Run Quantlab
./scripts/code.sh
```

### Build for Distribution

```bash
# Linux x64
npm run gulp vscode-linux-x64

# Minified build
npm run gulp vscode-linux-x64-min
```

## Development Container

For consistent development environments, use the included Dev Container configuration:

```bash
# Open in VS Code with Dev Containers extension
code --new-window .
# Then: "Dev Containers: Reopen in Container"
```

Requirements: Docker with at least 4 cores and 6 GB RAM (8 GB recommended).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

Licensed under the [MIT License](LICENSE.txt).
