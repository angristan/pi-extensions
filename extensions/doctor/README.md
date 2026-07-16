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

╭ Pi Doctor · all green ───────────────────────────────╮
│ Extensions                                           │
│ ✓ 9 discovered extension entries                      │
│ ✓ No duplicate extension commands or shortcuts       │
│                                                       │
│ Runtime patches and caches                            │
│ ✓ Markdown code-block renderer   1 owner(s); original │
│ ✓ TUI line-reset cache   4,221 entries; 3,221 hits    │
│ · better-native-pi      1,204 renders · 87.3% hit     │
╰──────────────────────────────────────────────────────╯
↑↓/PgUp/PgDn scroll · Home/End · q close · 42 rows
```

Checks include: settings.json/models.json validity, model auth availability,
code-blocks + cached-line-resets patch status, renderer-cache hit rates, and
recent `pi-debug.log` startup failures.
