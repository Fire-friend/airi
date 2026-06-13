# screenpipe sidecar resources

AIRI's Electron package copies the current platform directory from `build/screenpipe/${os}` into `process.resourcesPath/screenpipe`.

Expected local layout before packaging:

- `build/screenpipe/win/screenpipe.exe`
- `build/screenpipe/mac/screenpipe`
- `build/screenpipe/linux/screenpipe`

The screen observation runtime also supports development overrides through `AIRI_SCREENPIPE_BIN` or `SCREENPIPE_BIN`, and falls back to common user install locations such as `~/screenpipe/bin`.
