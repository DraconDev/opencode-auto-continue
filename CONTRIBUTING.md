# Contributing

Thank you for your interest in contributing to opencode-auto-continue.

## Development Setup

```bash
git clone https://github.com/DraconDev/opencode-auto-continue
cd opencode-auto-continue
npm install
```

## Commands

```bash
npm run build    # Compile TypeScript to JavaScript
npm run test     # Run test suite
npm run test:watch  # Run tests in watch mode
```

## Testing

Tests are written with [Vitest](https://vitest.dev/). Write tests in `src/__tests__/*.test.ts`.

```bash
npm test
```

## Making Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Add tests for new functionality
5. Ensure all tests pass (`npm test`)
6. Commit with a clear message (consider using [conventional commits](https://www.conventionalcommits.org/))
7. Push to your fork
8. Open a Pull Request

## Release Process

When you're ready to release a new version:

```bash
# Update version in package.json
npm version minor --no-git-tag-version  # or patch/major depending on changes

# Create git tag
git tag v$(node -p "require('./package.json').version")

# Push tag to trigger GitHub Actions + npm publish
git push origin --tags
```

This will automatically:
- Run tests
- Build the project
- Publish to npm
- Create a GitHub release

## Code Style

- Use TypeScript for all new code
- Follow existing patterns in the codebase
- Ensure type safety (no `any` unless absolutely necessary)

## Reporting Issues

Please report issues at https://github.com/DraconDev/opencode-auto-continue/issues with:
- Steps to reproduce
- Expected vs actual behavior
- OpenCode version
- Plugin configuration