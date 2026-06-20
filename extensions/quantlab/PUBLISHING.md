# Publishing the Quantlab / Quantbook extension to Open VSX (R17)

Status: **publish-READY metadata only. An actual Open VSX publish is still BLOCKED** (see below).
This is deliberate -- a publish workflow that cannot produce a working VSIX would be a hollow artifact.

## Done in Wave J-b (2026-06-20)
- `package.json` marketplace metadata: `repository`, `bugs`, `homepage`, `keywords`, and broader
  `categories` (`Data Science`, `Visualization`, `Other`).
- `.vscodeignore` so a standalone VSIX would ship `out/src/` + `dist/` + `media/` and exclude sources,
  tests (incl. compiled `out/**/test`), webview sources, Python scratch, and build configs.

The Open VSX publish CLI (`ovsx`) is intentionally NOT added to `devDependencies`: it is only needed at
publish time and adding it here would force a large `package-lock.json` resolution against the fork's
locked tree. Run it ad hoc with `npx ovsx ...` (or add it as a dependency only when the extension is
extracted into its own standalone build).

## Blockers before a real Open VSX publish (NOT done -- each is a separate, deliberate decision)

1. **The native engine binary is not bundled.** The Quantbook engine
   (`libql_bindings_node.{dylib,so,dll}`) is loaded at dev time from a sibling worktree via
   `src/quantbook/loader.ts` (the `QUANTBOOK_ENGINE_PATH` env var or the
   `quantlab-quantbook/quantbook-engine/target/release/` path) -- it is NOT inside the extension.
   A working VSIX must ship the binary and the loader must resolve it from the extension directory.
   Because the binary is platform-specific, this means **per-platform VSIXes**
   (`ovsx publish --target darwin-arm64 | darwin-x64 | linux-x64 | win32-x64 ...`), one engine `.node`
   each. This is the loader's deferred "V2 publish pipeline" and is the largest piece of work.

2. **`"private": true` should be removed for a standalone release.** It guards this fork built-in from
   accidental `npm publish`. It is not necessarily a hard vsce/ovsx packaging error, but removing it is
   correct release hygiene when extracting the extension into a standalone VSIX build.

3. **No extension icon.** Only `media/icons/quantbook.svg` exists, and vsce/ovsx reject an SVG as the
   `"icon"`. A 128x128 PNG export plus an `"icon"` field is expected for a marketplace listing
   (recommended, not strictly mandatory for packaging).

4. **Distribution-model decision (the prerequisite).** This repo is a VS Code FORK (`code-oss-dev`);
   `quantlab` is a built-in extension, and the fork's `product.json` already points `extensionsGallery`
   at Open VSX (that is how the *app* loads other extensions, NOT how this extension is published).
   Decide between:
   - (a) Ship the **forked desktop app** "Quantlab" -- then publishing this extension to Open VSX is moot;
     the engine binary ships inside the app build instead.
   - (b) Extract `quantlab` as a **standalone VSIX** on Open VSX -- then blockers 1-3 apply, plus a
     per-extension `README.md` and `LICENSE` copied into the extension directory.

## Publish command (once unblocked, path (b))
    # build per platform, then:
    ovsx publish --target <platform> -p "$OVSX_TOKEN"
