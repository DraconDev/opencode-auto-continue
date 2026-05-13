# Releasing

## Version Strategy

This project uses **semantic versioning** via git tags. The version in `package.json` is the source of truth.

## Making a Release

### 1. Ensure you're ready to release

```bash
# Make sure everything is committed
git status
```

### 2. Bump the version and tag

**Patch release** (bug fixes):
```bash
npm version patch --no-git-tag
git tag v$(node -p "require('./package.json').version")
```

**Minor release** (new features, backward compatible):
```bash
npm version minor --no-git-tag
git tag v$(node -p "require('./package.json').version")
```

**Major release** (breaking changes):
```bash
npm version major --no-git-tag
git tag v$(node -p "require('./package.json').version")
```

### 3. Push tags to trigger automated publish

```bash
git push origin --tags
```

Pushing a tag matching `v*` triggers the [publish workflow](.github/workflows/publish.yml) which:
1. Installs dependencies and builds
2. Runs tests
3. Publishes to npm (`@dracondev/opencode-auto-continue`)
4. Creates a GitHub Release with release notes

## Emergency Manual Publish (fallback only)

If the automated workflow fails and you need to publish manually:

```bash
npm publish --access public
```

> Note: Requires being logged into npm (`npm login`). Uses scoped package `@dracondev/opencode-auto-continue`.

### Manual GitHub Release (fallback only)

If the automated release creation fails:
1. Go to https://github.com/DraconDev/opencode-auto-continue/releases
2. Click "Draft a new release"
3. Select the tag you just pushed
4. Title: `v1.0.0` (matching the tag)
5. Description: summarize changes since last release

## Checking a Tag

```bash
git log v1.0.0 --oneline
```

## Listing Tags

```bash
git tag -l
```
