# doctor

Run diagnostics on your pi setup.

`/doctor` inspects your configuration, installed extensions, model registry,
provider auth, runtime patches, and caches — then reports a status for each
item with a glyph:

- `✓` ok (green)
- `!` warning (yellow)
- `×` error (red)
- `·` info (dim)

```
/doctor

Extensions
✓ 9 discovered extension entries
! 2 passive or unverified entries
✓ No duplicate extension commands or shortcuts

Runtime patches and caches
✓ Markdown code-block renderer   1 owner(s); original retained
✓ TUI line-reset cache   4,221 entries; 3,221 hits / 38 misses; original retained
· better-native-pi      1,204 renders · 87.3% hit · 312 volatile
· better-native-pi:bash   482 renders · 91.0% hit ·   0 volatile

Models and provider configuration
✓ settings.json parsed
✓ Model registry loaded · 9/9 models have configured auth
```

Checks include: settings.json/models.json validity, model auth availability,
code-blocks + cached-line-resets patch status, renderer-cache hit rates, and
recent `pi-debug.log` startup failures.
